using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "ghcr-tests", worker = (
      compatibilityDate = "2024-09-23",
      modules = [
        (name = "runtime.mjs", esModule = embed "workerd.test.mjs"),
        (name = "worker.mjs", esModule = embed "../_worker.js")
      ],
      globalOutbound = (name = "ghcr-tests", entrypoint = "upstream")
    ))
  ]
);
