(function () {
  'use strict';

  var SIGNER_URL = 'http://127.0.0.1:9191/sign';

  function cargarCertificado() {
    return fetch('digital-certificate.txt', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('No se pudo cargar digital-certificate.txt (HTTP ' + r.status + ').');
        return r.text();
      });
  }

  qz.security.setCertificatePromise(function (resolve, reject) {
    cargarCertificado().then(resolve).catch(reject);
  });

  qz.security.setSignatureAlgorithm('SHA512');

  qz.security.setSignaturePromise(function (toSign) {
    return function (resolve, reject) {
      fetch(SIGNER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toSign: toSign })
      })
      .then(function (r) {
        if (!r.ok) throw new Error('Firmador local no responde (HTTP ' + r.status + ').');
        return r.json();
      })
      .then(function (data) {
        if (!data.signature) throw new Error('El firmador local no devolvio una firma.');
        resolve(data.signature);
      })
      .catch(function (err) {
        reject(new Error('No se pudo firmar con el firmador local. ' + err.message));
      });
    };
  });

  window.soloAgroQZSeguridadLista = true;
})();
