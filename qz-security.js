/* SoloAgro - firma local para QZ Tray
 * Requiere digital-certificate.txt y private-key.pem en esta misma carpeta.
 * La clave privada permanece en el PC; no se envía a internet.
 */
(function () {
  'use strict';

  function cargarTexto(ruta) {
    return fetch(ruta, { cache: 'no-store', headers: { 'Content-Type': 'text/plain' } })
      .then(function (r) {
        if (!r.ok) throw new Error('No se pudo cargar ' + ruta + ' (HTTP ' + r.status + ').');
        return r.text();
      });
  }

  function pemABytes(pem) {
    var base64 = String(pem)
      .replace(/-----BEGIN PRIVATE KEY-----/g, '')
      .replace(/-----END PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '');
    var bin = atob(base64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesABase64(bytes) {
    var bin = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  var certPromise = cargarTexto('digital-certificate.txt');
  var keyPromise = cargarTexto('private-key.pem').then(function (pem) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('El navegador no permite Web Crypto para firmar QZ Tray en esta página.');
    }
    return window.crypto.subtle.importKey(
      'pkcs8',
      pemABytes(pem).buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
      false,
      ['sign']
    );
  });

  qz.security.setCertificatePromise(function (resolve, reject) {
    certPromise.then(resolve).catch(reject);
  });

  qz.security.setSignatureAlgorithm('SHA512');

  qz.security.setSignaturePromise(function (toSign) {
    return function (resolve, reject) {
      keyPromise
        .then(function (key) {
          return window.crypto.subtle.sign(
            { name: 'RSASSA-PKCS1-v1_5' },
            key,
            new TextEncoder().encode(toSign)
          );
        })
        .then(function (signature) {
          resolve(bytesABase64(new Uint8Array(signature)));
        })
        .catch(reject);
    };
  });

  window.soloAgroQZSeguridadLista = true;
})();
