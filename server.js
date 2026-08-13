const http = require("http");
const https = require("https");

const BACKENDS = [
  {
    name: "LOCAL",
    url: process.env.BACKEND_LOCAL,
    healthy: true,
    latency: Infinity,
    failures: 0
  },
  {
    name: "AZURE",
    url: process.env.BACKEND_AZURE,
    healthy: true,
    latency: Infinity,
    failures: 0
  }
].filter(backend => backend.url);

if (BACKENDS.length < 2) {
  console.error("Debes configurar BACKEND_LOCAL y BACKEND_AZURE");
  process.exit(1);
}

const HEALTH_INTERVAL = 10000; // 10 segundos
const TIMEOUT = 5000;           // 5 segundos
const MAX_FAILURES = 2;

// --------------------------------------------------
// HEALTH CHECK + PERFORMANCE
// --------------------------------------------------

function checkBackend(backend) {
  const target = new URL(backend.url);
  const client = target.protocol === "https:" ? https : http;

  const start = Date.now();

  const options = {
    hostname: target.hostname,
    port:
      target.port ||
      (target.protocol === "https:" ? 443 : 80),

    path: "/",
    method: "GET",

    headers: {
      Host: target.host
    },

    timeout: TIMEOUT
  };

  const request = client.request(options, response => {
    const latency = Date.now() - start;

    response.resume();

    if (response.statusCode >= 200 && response.statusCode < 500) {

      backend.latency = latency;
      backend.failures = 0;

      if (!backend.healthy) {
        console.log(`🟢 ${backend.name} volvió ONLINE`);
      }

      backend.healthy = true;

      console.log(
        `💚 ${backend.name} | HEALTHY | ${latency} ms`
      );

    } else {

      registerFailure(
        backend,
        `HTTP ${response.statusCode}`
      );
    }
  });

  request.on("timeout", () => {
    request.destroy();
    registerFailure(backend, "TIMEOUT");
  });

  request.on("error", error => {
    registerFailure(backend, error.message);
  });

  request.end();
}

function registerFailure(backend, reason) {

  backend.failures++;

  console.log(
    `⚠️ ${backend.name} fallo ` +
    `(${backend.failures}/${MAX_FAILURES}) | ${reason}`
  );

  if (backend.failures >= MAX_FAILURES) {

    if (backend.healthy) {
      console.log(`🔴 ${backend.name} marcado OFFLINE`);
    }

    backend.healthy = false;
    backend.latency = Infinity;
  }
}

// Health Check inicial
BACKENDS.forEach(checkBackend);

// Health Check periódico
setInterval(() => {
  BACKENDS.forEach(checkBackend);
}, HEALTH_INTERVAL);


// --------------------------------------------------
// PERFORMANCE SCORE
// --------------------------------------------------

function calculateScore(backend) {

  if (!backend.healthy) {
    return Infinity;
  }

  return backend.latency;
}


// --------------------------------------------------
// SELECCIÓN DEL BACKEND
// --------------------------------------------------

function selectBackend(excluded = []) {

  const available = BACKENDS.filter(
    backend =>
      backend.healthy &&
      !excluded.includes(backend.name)
  );

  if (available.length === 0) {
    return null;
  }

  // Si todavía no tenemos mediciones,
  // utilizamos Round Robin temporalmente.
  const measured = available.filter(
    backend => backend.latency !== Infinity
  );

  if (measured.length === 0) {

    return available[
      Math.floor(Math.random() * available.length)
    ];
  }

  // Ordenar por latencia
  measured.sort(
    (a, b) =>
      calculateScore(a) - calculateScore(b)
  );

  // ------------------------------------------------
  // PERFORMANCE WEIGHTED
  //
  // El backend más rápido recibe más probabilidad,
  // pero los demás siguen teniendo oportunidad.
  // ------------------------------------------------

  const weights = measured.map(backend => {

    const latency = Math.max(
      backend.latency,
      1
    );

    return {
      backend,
      weight: 1 / latency
    };
  });

  const totalWeight = weights.reduce(
    (sum, item) =>
      sum + item.weight,
    0
  );

  let random =
    Math.random() * totalWeight;

  for (const item of weights) {

    random -= item.weight;

    if (random <= 0) {
      return item.backend;
    }
  }

  return weights[0].backend;
}


// --------------------------------------------------
// PROXY
// --------------------------------------------------

function proxyRequest(
  backend,
  req,
  res,
  excluded = []
) {

  const target = new URL(backend.url);

  const client =
    target.protocol === "https:"
      ? https
      : http;

  const options = {

    hostname:
      target.hostname,

    port:
      target.port ||
      (
        target.protocol === "https:"
          ? 443
          : 80
      ),

    path: req.url,

    method: req.method,

    headers: {
      ...req.headers,
      host: target.host
    },

    timeout: TIMEOUT
  };


  console.log(
    `➡️ ${req.method} ${req.url} → ${backend.name}`
  );


  const proxy =
    client.request(
      options,
      response => {

        res.writeHead(
          response.statusCode,
          response.headers
        );

        response.pipe(res);
      }
    );


  proxy.setTimeout(
    TIMEOUT,
    () => {

      proxy.destroy(
        new Error(
          `Timeout en ${backend.name}`
        )
      );
    }
  );


  proxy.on(
    "error",
    error => {

      console.log(
        `❌ ${backend.name} falló: ` +
        error.message
      );

      // Marcar backend como no saludable
      backend.healthy = false;
      backend.failures = MAX_FAILURES;
      backend.latency = Infinity;

      excluded.push(
        backend.name
      );


      // Buscar otro backend
      const alternative =
        selectBackend(excluded);


      if (alternative) {

        console.log(
          `🔄 FAILOVER: ${backend.name} → ` +
          `${alternative.name}`
        );


        proxyRequest(
          alternative,
          req,
          res,
          excluded
        );

        return;
      }


      if (!res.headersSent) {

        res.writeHead(502);

        res.end(
          "Todos los servidores backend " +
          "están fuera de servicio"
        );

      } else {

        res.end();
      }
    }
  );


  req.pipe(proxy);
}


// --------------------------------------------------
// SERVIDOR
// --------------------------------------------------

const server =
  http.createServer(
    (req, res) => {

      const backend =
        selectBackend();


      if (!backend) {

        res.writeHead(503);

        res.end(
          "No hay servidores disponibles"
        );

        return;
      }


      proxyRequest(
        backend,
        req,
        res
      );
    }
  );


const PORT =
  process.env.PORT || 10000;


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 Load Balancer escuchando ` +
      `en puerto ${PORT}`
    );

    console.log(
      "Backends:"
    );

    BACKENDS.forEach(
      backend => {

        console.log(
          `  ${backend.name}: ` +
          `${backend.url}`
        );
      }
    );

    console.log(
      `Health Check: cada ` +
      `${HEALTH_INTERVAL / 1000}s`
    );

  }
);
