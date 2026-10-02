import { PROTO_VERSION } from "../protocol";

// Pantalla provisional: la app se irá construyendo fase a fase.
export function App() {
  return (
    <main>
      <h1>SkiCoach</h1>
      <p class="muted">v1 en construcción · protocolo v{PROTO_VERSION}</p>
      <p>
        <a href="./bgtest.html">Prueba en segundo plano (BLE + voz con la pantalla bloqueada)</a>
      </p>
    </main>
  );
}
