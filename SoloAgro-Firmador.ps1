# SoloAgro - firmador local para QZ Tray
# Compatible con Windows PowerShell 5.1 (incluido en Windows).
$ErrorActionPreference = 'Stop'
$Port = 9191
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$KeyPath = Join-Path $Root 'private-key.pem'

if (-not (Test-Path -LiteralPath $KeyPath)) {
  Write-Host "ERROR: No encuentro private-key.pem en:" -ForegroundColor Red
  Write-Host $Root -ForegroundColor Red
  Read-Host 'Pulsa ENTER para salir'
  exit 1
}

# Cargador RSA para PKCS#8/PKCS#1 sin instalar librerias externas.
Add-Type -TypeDefinition @'
using System;
using System.Security.Cryptography;

public static class SoloAgroRsa {
    static byte[] ReadLen(byte[] b, ref int p) {
        int x = b[p++];
        if (x < 128) return new byte[] { (byte)x };
        int n = x & 127;
        // FIX: antes esto calculaba v correctamente pero lo devolvia
        // truncado a (byte)v, perdiendo todos los bytes menos el ultimo.
        // Para una llave RSA de 2048 bits las longitudes ASN.1 siempre
        // superan 255, asi que esto rompia SIEMPRE la lectura desde el
        // primer bloque. Ahora se devuelven los n bytes reales.
        byte[] result = new byte[n];
        for (int i = 0; i < n; i++) { result[i] = b[p++]; }
        return result;
    }
    static byte[] ReadTlv(byte[] b, ref int p, byte tag) {
        if (b[p++] != tag) throw new Exception("PEM DER invalido");
        byte[] lb = ReadLen(b, ref p);
        int len = 0; foreach (byte z in lb) len = (len << 8) | z;
        if (p + len > b.Length) throw new Exception("PEM DER truncado");
        byte[] v = new byte[len]; Buffer.BlockCopy(b,p,v,0,len); p += len; return v;
    }
    static void Skip(byte[] b, ref int p, byte tag) { ReadTlv(b, ref p, tag); }
    static byte[] IntVal(byte[] b, ref int p) {
        byte[] v = ReadTlv(b, ref p, 0x02);
        int i=0; while(i<v.Length-1 && v[i]==0) i++;
        byte[] r = new byte[v.Length-i]; Buffer.BlockCopy(v,i,r,0,r.Length);
        Array.Reverse(r); return r;
    }
    static RSAParameters ParseRsaPrivateKey(byte[] der) {
        int p=0; byte[] seq=ReadTlv(der,ref p,0x30); p=0;
        Skip(seq,ref p,0x02);
        RSAParameters rp = new RSAParameters();
        rp.Modulus=IntVal(seq,ref p); rp.Exponent=IntVal(seq,ref p); rp.D=IntVal(seq,ref p);
        rp.P=IntVal(seq,ref p); rp.Q=IntVal(seq,ref p); rp.DP=IntVal(seq,ref p); rp.DQ=IntVal(seq,ref p); rp.InverseQ=IntVal(seq,ref p);
        return rp;
    }
    public static RSACryptoServiceProvider Load(string pem) {
        string s=pem.Replace("\r","").Replace("\n","").Trim();
        byte[] der;
        if (pem.Contains("BEGIN PRIVATE KEY")) {
            s=s.Replace("-----BEGIN PRIVATE KEY-----","").Replace("-----END PRIVATE KEY-----","");
            der=Convert.FromBase64String(s);
            int p=0; byte[] outer=ReadTlv(der,ref p,0x30); p=0;
            Skip(outer,ref p,0x02); // version
            Skip(outer,ref p,0x30); // algorithm identifier
            byte[] inner=ReadTlv(outer,ref p,0x04); // RSAPrivateKey DER
            RSAParameters rp=ParseRsaPrivateKey(inner);
            var rsa=new RSACryptoServiceProvider(2048); rsa.ImportParameters(rp); return rsa;
        }
        if (pem.Contains("BEGIN RSA PRIVATE KEY")) {
            s=s.Replace("-----BEGIN RSA PRIVATE KEY-----","").Replace("-----END RSA PRIVATE KEY-----","");
            der=Convert.FromBase64String(s); RSAParameters rp=ParseRsaPrivateKey(der);
            var rsa=new RSACryptoServiceProvider(2048); rsa.ImportParameters(rp); return rsa;
        }
        throw new Exception("private-key.pem no es PKCS#8 ni RSA PRIVATE KEY.");
    }
}
'@

$pem = Get-Content -Raw -LiteralPath $KeyPath
$rsa = [SoloAgroRsa]::Load($pem)
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

Write-Host "" 
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " SOLOAGRO - FIRMADOR QZ TRAY" -ForegroundColor Green
Write-Host " http://127.0.0.1:$Port/" -ForegroundColor Green
Write-Host "" 
Write-Host "Puedes cerrar esta ventana cuando termines." -ForegroundColor Yellow
Write-Host "private-key.pem permanece SOLO en este PC." -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

try {
  while ($listener.IsListening) {
    $ctx=$listener.GetContext(); $req=$ctx.Request; $res=$ctx.Response
    $res.Headers.Add('Access-Control-Allow-Origin','*')
    $res.Headers.Add('Access-Control-Allow-Methods','POST, OPTIONS')
    $res.Headers.Add('Access-Control-Allow-Headers','Content-Type')
    if ($req.HttpMethod -eq 'OPTIONS') { $res.StatusCode=204; $res.Close(); continue }
    if ($req.HttpMethod -ne 'POST' -or $req.Url.AbsolutePath -ne '/sign') { $res.StatusCode=404; $res.Close(); continue }
    $reader=New-Object System.IO.StreamReader($req.InputStream,$req.ContentEncoding)
    $body=$reader.ReadToEnd(); $reader.Dispose()
    $obj=$body | ConvertFrom-Json
    $toSign=[string]$obj.toSign
    if ([string]::IsNullOrEmpty($toSign)) { throw 'Falta toSign.' }
    $data=[Text.Encoding]::UTF8.GetBytes($toSign)
    $sig=$rsa.SignData($data,[Security.Cryptography.CryptoConfig]::MapNameToOID('SHA512'))
    $json=(@{signature=[Convert]::ToBase64String($sig)} | ConvertTo-Json -Compress)
    $out=[Text.Encoding]::UTF8.GetBytes($json)
    $res.ContentType='application/json; charset=utf-8'; $res.StatusCode=200; $res.ContentLength64=$out.Length
    $res.OutputStream.Write($out,0,$out.Length); $res.Close()
  }
} catch {
  Write-Host "Error del firmador: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  if ($rsa) { $rsa.Dispose() }; if ($listener) { $listener.Stop(); $listener.Close() }
}
