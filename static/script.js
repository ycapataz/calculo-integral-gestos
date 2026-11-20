/* ============================================================
   CÁLCULO INTEGRAL EN MOVIMIENTO - script.js
   ------------------------------------------------------------
   Este archivo controla:
     1. Estado global de la app (función, límites, cámara, etc.)
     2. Formateo uniforme de números con decimales controlados.
     3. Envío de datos al backend Flask (curva y cálculo).
     4. Gestión de la cámara: permiso, pausa, errores.
     5. Detección de gestos con MediaPipe (contar dedos).
     6. Dibujo de las gráficas 2D y 3D con Plotly.
     7. Renderizado de las fórmulas en LaTeX con KaTeX.

   Mapa de gestos:
     1 dedo  → Área bajo la curva
     2 dedos → Volumen al rotar sobre el eje X
     3 dedos → Volumen al rotar sobre el eje Y
     4 dedos → Superficie de revolución
     5 dedos → Longitud de arco
   ============================================================ */


/* ============================================================
   1) ESTADO GLOBAL
   Variables que guardan la configuración actual y el estado
   de la cámara. Se declaran fuera de cualquier función para
   que todas puedan accederlas.
   ============================================================ */

let funcionActual = "";        // Expresión activa (ej: "x**2")
let aActual = 0, bActual = 0;  // Límites de integración
let ejeActual = "x";           // Eje de revolución ('x' o 'y')

let ultimoGesto = -1;          // Último número de dedos procesado (evita repetir)
let curvaCache = null;         // Puntos de la curva devueltos por /api/curva

let pausado = false;           // ¿Cámara pausada por el usuario?
let modoManual = false;        // ¿Modo manual activado?
let manoDetectada = false;     // ¿Hay una mano visible ahora?
let timeoutMano = null;        // Timer para avisar cuando se pierde la mano

let cameraStream = null;       // MediaStream de la webcam (para poder detenerlo)
let frameLoopId = null;        // ID del bucle requestAnimationFrame

// Cantidad de decimales que se muestran en los resultados
const DECIMALES = 4;


/* ============================================================
   2) FORMATEO DE NÚMEROS
   Convierte cualquier valor numérico a string con formato
   uniforme. Usa notación científica si el valor es muy grande
   o muy pequeño para no romper el layout.
   ============================================================ */
function fmt(v) {
  const n = Number(v);

  // Si no es un número válido, lo devolvemos tal cual
  if (!isFinite(n)) return v;

  // Notación científica para valores extremos
  if (n !== 0 && (Math.abs(n) >= 1e6 || Math.abs(n) < 1e-3)) {
    return n.toExponential(DECIMALES);
  }

  // Formato decimal fijo (ej: 2.6667)
  return n.toFixed(DECIMALES);
}


/* ============================================================
   3) APLICAR CONFIGURACIÓN
   Se ejecuta al pulsar "Aplicar" o al cargar la página.
   Valida los campos, guarda la función y recarga la curva.
   ============================================================ */
async function aplicar() {
  const f = document.getElementById('funcion').value.trim();
  const a = document.getElementById('a').value.trim();
  const b = document.getElementById('b').value.trim();

  // Validación básica: los 3 campos deben estar llenos
  if (!f || !a || !b) {
    document.getElementById('estado').textContent =
      '⚠ Completa función, a y b antes de aplicar.';
    return;
  }

  funcionActual = f;
  aActual       = parseFloat(a);
  bActual       = parseFloat(b);
  ejeActual     = document.getElementById('eje').value;

  await cargarCurva();

  document.getElementById('estado').textContent = "Función aplicada. Muestra 1-5 dedos.";
  ultimoGesto = -1;   // Reset para que el próximo gesto cuente como nuevo
}


/* ============================================================
   4) CARGAR CURVA
   Llama al endpoint /api/curva del backend. Recibe:
     - x, y     → puntos para dibujar f(x)
     - u, theta → malla paramétrica del sólido 3D
     - R        → radio |f(u)| para cada (u, theta)
   ============================================================ */
async function cargarCurva() {
  const r = await fetch('/api/curva', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({funcion: funcionActual, a: aActual, b: bActual})
  });
  curvaCache = await r.json();
}


/* ============================================================
   5) EJECUTAR CÁLCULO
   Envía el número de dedos al backend y muestra el resultado
   con formato bonito usando KaTeX.
   ============================================================ */
async function ejecutar(n) {
  // Aviso si aún no se ha definido una función
  if (!funcionActual) {
    document.getElementById('resultado').innerHTML =
      '<span style="color:#ffaa00">⚠ Primero define una función y pulsa Aplicar.</span>';
    return;
  }

  const r = await fetch('/api/calcular', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      funcion: funcionActual, a: aActual, b: bActual, eje: ejeActual, n: n
    })
  });
  const data = await r.json();

  // Manejo de errores del backend
  if (data.error) {
    document.getElementById('resultado').innerHTML =
      '<span style="color:#e94560">Error: ' + data.error + '</span>';
    return;
  }

  // Diccionarios para nombres e iconos bonitos según el tipo
  const tiposBonitos = {
    area: 'Área',
    volumen_x: 'Volumen · eje X',
    volumen_y: 'Volumen · eje Y',
    superficie: 'Superficie de revolución',
    longitud: 'Longitud de arco'
  };

  const iconos = {
    area: '📐',
    volumen_x: '🥣',
    volumen_y: '🏺',
    superficie: '🌀',
    longitud: '📏'
  };

  // NUEVO: Validar si el resultado es indeterminado (NaN o null desde Python)
  const esIndeterminado = isNaN(data.resultado) || data.resultado === null;
  
  if (esIndeterminado) {
    // Reemplazamos el valor de LaTeX por un texto que explique el error
    data.latex_valor = String.raw`\text{No evaluable (Límite indeterminado)}`;
  }

  // NUEVO: Determinamos el color del estado (rojo si falló, verde si convergió)
  const colorEstado = esIndeterminado ? '#ff4444' : '#00ff88';

  // Estructura HTML del panel de resultado
  let html = `
    <div class="res-header">
      <span class="res-icono">${iconos[data.tipo] || '🧮'}</span>
      <span class="res-tipo">${(data.tipo_nombre || tiposBonitos[data.tipo] || data.tipo).toUpperCase()}</span>
      <span class="res-dedo">${n} dedo${n > 1 ? 's' : ''}</span>
    </div>
    
    <!-- NUEVO: Mostrar el método utilizado -->
    <div class="res-metodo" style="font-size: 13px; color: #aaa; margin-bottom: 10px; border-bottom: 1px solid #333; padding-bottom: 5px;">
      <strong>Método:</strong> ${data.metodo || 'No especificado'}
    </div>

    <div class="res-formula">$$${data.latex}$$</div>
    <div class="res-valor">$$${data.latex_valor}$$</div>

    <!-- NUEVO: Mostrar el estado del límite -->
    <div class="res-estado" style="margin-top: 10px; font-weight: bold; color: ${colorEstado}; font-size: 14px;">
      Estado: ${data.limite || 'Desconocido'}
    </div>
  `;

  // Bloque adicional solo para el área (integral con signo)
  if (data.latex_signo) {
    html += `
      <div class="res-extra">
        <div class="res-extra-titulo">Integral con signo</div>
        <div class="res-extra-formula">$$${data.latex_signo}$$</div>
      </div>
    `;
  }

  const cont = document.getElementById('resultado');
  cont.innerHTML = html;

  // Renderizamos LaTeX (usando renderLatex del HTML o auto-render)
  if (typeof renderLatex === 'function') {
    renderLatex(cont);
  } else if (window.renderMathInElement) {
    renderMathInElement(cont, {
      delimiters: [
        {left: '$$', right: '$$', display: true},
        {left: '$',  right: '$',  display: false}
      ],
      throwOnError: false
    });
  }

  document.getElementById('estado').textContent = `${n} dedo(s) → ${data.tipo}`;

  // Redibujamos las gráficas con el gesto actual
  dibujar2D(n);
  dibujar3D(n);
}


/* ============================================================
   6) CÁMARA
   ============================================================ */

/* Se llama desde el botón del panel de permiso */
function solicitarPermisoCamara() {
  document.getElementById('errorCam').style.display = 'none';
  document.getElementById('estado').textContent = 'Solicitando permiso...';
  iniciarCamara();
}

/* Pide acceso a la cámara y arranca el bucle de detección */
function iniciarCamara() {
  document.getElementById('panelPermiso').style.display = 'none';
  document.getElementById('errorCam').style.display = 'none';

  // Verificar compatibilidad del navegador
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    mostrarErrorCamara(
      'Navegador no compatible',
      'Tu navegador no soporta el acceso a la cámara. Usa Chrome, Edge o Firefox actualizado.'
    );
    return;
  }

  navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: false
  }).then((stream) => {
    cameraStream = stream;
    video.srcObject = stream;

    // Mostrar video, ocultar paneles
    document.getElementById('contenedorVideo').style.display = 'block';
    document.getElementById('panelPermiso').style.display = 'none';
    document.getElementById('errorCam').style.display = 'none';

    // Actualizar indicador
    const est = document.getElementById('camEstado');
    est.textContent = '● Cámara activa';
    est.className = 'cam-estado';
    document.getElementById('estado').textContent = 'Esperando mano...';

    return video.play();
  }).then(() => {
    // Bucle que envía frames a MediaPipe mientras no esté pausada
    const loop = async () => {
      if (!cameraStream) return;               // cámara detenida
      if (!pausado) {
        try { await hands.send({image: video}); } catch (e) {}
      }
      frameLoopId = requestAnimationFrame(loop);
    };
    loop();
  }).catch((err) => {
    manejarErrorCamara(err);
  });
}

/* Traduce cada tipo de error del navegador a un mensaje amigable */
function manejarErrorCamara(err) {
  let titulo = 'Error de cámara';
  let detalle = 'No se pudo acceder a la cámara.';

  switch (err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      titulo = '🚫 Permiso denegado';
      detalle = 'Bloqueaste el acceso. Haz clic en el candado 🔒 de la barra de direcciones, permite la cámara y pulsa Reintentar.';
      break;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      titulo = '📷 No se encontró cámara';
      detalle = 'No hay ninguna cámara conectada. Conecta una webcam o usa el modo manual.';
      break;
    case 'NotReadableError':
    case 'TrackStartError':
      titulo = '⚙ Cámara ocupada';
      detalle = 'Otra app está usando la cámara (Zoom, Teams, Meet...). Ciérrala y pulsa Reintentar.';
      break;
    case 'OverconstrainedError':
      titulo = '🎞 Cámara incompatible';
      detalle = 'Tu cámara no soporta la resolución solicitada.';
      break;
    case 'SecurityError':
      titulo = '🔒 Contexto no seguro';
      detalle = 'La cámara solo funciona en HTTPS o localhost.';
      break;
    case 'TypeError':
      titulo = '🔗 Sin conexión segura';
      detalle = 'Se requiere HTTPS para acceder a la cámara. Usa localhost.';
      break;
    default:
      detalle = err.message || 'Error desconocido.';
  }

  mostrarErrorCamara(titulo, detalle);

  // Activar modo manual como respaldo si no lo estaba ya
  if (!modoManual) toggleManual();
}

/* Muestra el panel rojo de error con título y detalle */
function mostrarErrorCamara(titulo, detalle) {
  document.getElementById('errorTitulo').textContent = titulo;
  document.getElementById('errorDetalle').textContent = detalle;
  document.getElementById('errorCam').style.display = 'block';
  document.getElementById('contenedorVideo').style.display = 'none';
  document.getElementById('panelPermiso').style.display = 'none';

  const est = document.getElementById('camEstado');
  est.textContent = '● Error de cámara';
  est.className = 'cam-estado error';
}

/* Detiene por completo la cámara: cancela el bucle y libera el hardware */
function detenerCamara() {
  if (frameLoopId) {
    cancelAnimationFrame(frameLoopId);
    frameLoopId = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());  // apaga el LED
    cameraStream = null;
  }
  if (video.srcObject) {
    video.srcObject = null;
  }
}

/* Alterna entre cámara activa y pausada */
function togglePausa() {
  pausado = !pausado;
  const btn = document.getElementById('btnPausa');
  const est = document.getElementById('camEstado');
  const panel = document.getElementById('panelPermiso');

  if (pausado) {
    // Apagar cámara y mostrar el panel con texto de "pausada"
    detenerCamara();

    document.getElementById('contenedorVideo').style.display = 'none';
    panel.style.display = 'flex';
    panel.querySelector('h3').textContent = 'Cámara pausada';
    panel.querySelector('p').textContent =
      'Pulsa el botón para volver a activar la cámara.';
    document.getElementById('btnPermitir').textContent = '▶ Reanudar cámara';
    document.getElementById('btnPermitir').onclick = togglePausa;

    btn.textContent = '▶ Reanudar cámara';
    btn.classList.add('activo');
    est.textContent = '● Cámara apagada';
    est.className = 'cam-estado pausada';
    document.getElementById('estado').textContent = 'Cámara apagada.';
  } else {
    // Restaurar textos del panel y reanudar cámara
    panel.querySelector('h3').textContent = 'Permiso de cámara';
    panel.querySelector('p').textContent =
      'Esta aplicación necesita acceso a tu cámara para detectar los gestos con la mano.';
    document.getElementById('btnPermitir').textContent = 'Permitir acceso a la cámara';
    document.getElementById('btnPermitir').onclick = solicitarPermisoCamara;

    btn.textContent = '⏸ Pausar cámara';
    btn.classList.remove('activo');
    iniciarCamara();
  }
}


/* ============================================================
   7) REINICIAR / MODO MANUAL
   ============================================================ */

/* Vuelve todo al estado inicial: campos vacíos, gráficas limpias */
async function reiniciar() {
  // Vaciar formulario
  document.getElementById('funcion').value = '';
  document.getElementById('a').value = '';
  document.getElementById('b').value = '';
  document.getElementById('eje').value = 'x';

  // Vaciar estado interno
  funcionActual = "";
  aActual = 0;
  bActual = 0;
  ejeActual = 'x';
  curvaCache = null;
  ultimoGesto = -1;

  // Limpiar UI
  document.getElementById('resultado').textContent = '';
  document.getElementById('estado').textContent =
    'Sistema reiniciado. Ingresa una función, a, b y pulsa Aplicar.';
  document.getElementById('errorCam').style.display = 'none';

  // Limpiar gráficas
  Plotly.purge('plot2d');
  Plotly.purge('plot3d');
  document.getElementById('plot2d').innerHTML = '';
  document.getElementById('plot3d').innerHTML = '';

  // Desactivar modo manual si estaba encendido
  if (modoManual) {
    modoManual = false;
    const btnM = document.getElementById('btnManual');
    btnM.classList.remove('activo');
    btnM.textContent = '⌨ Modo manual';
  }
}

/* Alterna el modo manual (sin cámara). Al activarlo, pausa la cámara */
function toggleManual() {
  modoManual = !modoManual;
  const btn = document.getElementById('btnManual');
  btn.classList.toggle('activo', modoManual);
  btn.textContent = modoManual ? '⌨ Modo manual ON' : '⌨ Modo manual';

  if (modoManual) {
    if (!pausado) togglePausa();   // apaga la cámara automáticamente
    document.getElementById('estado').textContent =
      'Modo manual activo. Usa los botones 1-5 o las teclas 1-5.';
  } else {
    document.getElementById('estado').textContent =
      'Modo manual desactivado. Pulsa ▶ para reanudar la cámara.';
  }
}


/* ============================================================
   8) GRÁFICAS CON PLOTLY
   ============================================================ */

/* Dibuja la curva f(x) en 2D. Según el gesto:
     - n=1 → añade el área rellena de naranja
     - n=5 → resalta el arco de la curva en rojo
     - Otros → solo la curva cyan */
function dibujar2D(n) {
  if (!curvaCache || curvaCache.error) return;
  const x = curvaCache.x, y = curvaCache.y;

  const traces = [{
    x: x, y: y, mode: 'lines', name: 'f(x)',
    line: {color: 'cyan', width: 2}
  }];

  if (n === 1 || n === 5) {
    // Filtramos solo los puntos dentro de [a, b]
    const xs = [], ys = [];
    x.forEach((xi, i) => {
      if (xi >= aActual && xi <= bActual) { xs.push(xi); ys.push(y[i]); }
    });

    if (n === 1) {
      // Área: relleno naranja bajo la curva
      traces.push({
        x: xs, y: ys, fill: 'tozeroy', mode: 'none',
        fillcolor: 'rgba(255,165,0,0.45)', name: 'Área'
      });
    } else {
      // Longitud: arco resaltado en rojo grueso
      traces.push({
        x: xs, y: ys, mode: 'lines',
        line: {color: 'red', width: 4}, name: 'Arco'
      });
    }
  }

  // Layout con el tema oscuro de la app
  const layout = {
    paper_bgcolor: '#16213e', plot_bgcolor: '#16213e',
    font: {color: '#fff'}, margin: {l: 40, r: 20, t: 30, b: 40},
    title: {text: 'Vista 2D', font: {size: 13}},
    xaxis: {gridcolor: '#333'}, yaxis: {gridcolor: '#333'}
  };
  Plotly.react('plot2d', traces, layout, {displayModeBar: false});
}

/* Dibuja el sólido de revolución en 3D.
   Solo se muestra con 2, 3 o 4 dedos.
     - n=2 → rotación eje X: (u, r·cos θ, r·sin θ)
     - n=3 → rotación eje Y: (u·cos θ, r, u·sin θ)
     - n=4 → superficie: misma param. que n=3 */
function dibujar3D(n) {
  if (!curvaCache || curvaCache.error) return;

  // Limpiamos si el gesto no genera sólido
  if (n !== 2 && n !== 3 && n !== 4) {
    Plotly.purge('plot3d');
    document.getElementById('plot3d').innerHTML =
      '<div style="padding:20px;color:#888">Sólido 3D disponible con 2, 3 o 4 dedos</div>';
    return;
  }

  const u = curvaCache.u, theta = curvaCache.theta, R = curvaCache.R;
  const nu = u.length, nt = theta.length;

  // Construcción manual de la malla (X, Y, Z) para Plotly
  const X = [], Y = [], Z = [];
  for (let j = 0; j < nt; j++) {
    const xr = [], yr = [], zr = [];
    for (let i = 0; i < nu; i++) {
      const r = R[j][i];     // radio = |f(u)|
      const t = theta[j];    // ángulo

      if (n === 2) {
        // Giro sobre el eje X
        xr.push(u[i]);
        yr.push(r * Math.cos(t));
        zr.push(r * Math.sin(t));
      } else {
        // Giro sobre el eje Y (o superficie de revolución)
        xr.push(u[i] * Math.cos(t));
        yr.push(r);
        zr.push(u[i] * Math.sin(t));
      }
    }
    X.push(xr); Y.push(yr); Z.push(zr);
  }

  // Superficie con colormap Viridis
  const trace = {
    type: 'surface', x: X, y: Y, z: Z,
    colorscale: 'Viridis', showscale: false, opacity: 0.9
  };

  const layout = {
    paper_bgcolor: '#16213e',
    scene: {
      bgcolor: '#16213e',
      xaxis: {color: '#fff', gridcolor: '#333'},
      yaxis: {color: '#fff', gridcolor: '#333'},
      zaxis: {color: '#fff', gridcolor: '#333'}
    },
    font: {color: '#fff'}, margin: {l: 0, r: 0, t: 30, b: 0},
    title: {text: 'Sólido 3D', font: {size: 13}}
  };
  Plotly.react('plot3d', [trace], layout, {displayModeBar: false});
}

/* ============================================================
   10.5) MODAL DE AYUDA
   ============================================================ */
function abrirAyuda() {
  const modal = document.getElementById('modalAyuda');
  if (!modal) return;
  modal.classList.add('abierto');
  document.body.style.overflow = 'hidden';
}

function cerrarAyuda() {
  const modal = document.getElementById('modalAyuda');
  if (!modal) return;
  modal.classList.remove('abierto');
  document.body.style.overflow = '';
}

function cerrarAyudaSiFondo(event) {
  if (event.target.id === 'modalAyuda') cerrarAyuda();
}

function cambiarTab(nombre) {
  document.querySelectorAll('.modal-tabs .tab-btn').forEach(b => b.classList.remove('activo'));
  document.querySelectorAll('.modal-body .tab-panel').forEach(p => p.classList.remove('activo'));
  const btn = document.querySelector(`.tab-btn[data-tab="${nombre}"]`);
  const panel = document.getElementById('tab-' + nombre);
  if (btn) btn.classList.add('activo');
  if (panel) panel.classList.add('activo');
}


/* ============================================================
   9) MEDIAPIPE HANDS
   ============================================================ */

// Referencias al video y al canvas de dibujo
const video   = document.getElementById('video');
const overlay = document.getElementById('overlay');
const octx    = overlay.getContext('2d');

// Instancia de Hands (carga los modelos desde CDN)
const hands = new Hands({
  locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
});

// Configuración del detector
hands.setOptions({
  maxNumHands: 1,                // solo una mano
  modelComplexity: 0,            // modelo ligero (más rápido)
  minDetectionConfidence: 0.6,   // confianza mínima para detectar
  minTrackingConfidence: 0.5     // confianza mínima para seguir
});

/* Callback que se ejecuta por cada frame procesado.
   Dibuja el esqueleto de la mano y cuenta los dedos. */
hands.onResults((results) => {
  // Ajustar el canvas al tamaño real del video
  overlay.width  = video.videoWidth || 640;
  overlay.height = video.videoHeight || 480;
  octx.clearRect(0, 0, overlay.width, overlay.height);

  // Sin mano detectada en este frame
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    if (manoDetectada) {
      manoDetectada = false;
      clearTimeout(timeoutMano);
      // Avisamos solo si pasa 1.5 s sin detectar mano (evita parpadeos)
      timeoutMano = setTimeout(() => {
        if (!manoDetectada && !pausado) {
          document.getElementById('estado').textContent =
            'Mano no detectada. Acerca la mano o usa el teclado (1-5).';
        }
      }, 1500);
    }
    return;
  }

  // Mano detectada → cancelamos el aviso pendiente
  clearTimeout(timeoutMano);
  manoDetectada = true;

  // Dibujar los 21 landmarks y las conexiones del esqueleto
  const lm = results.multiHandLandmarks[0];
  drawConnectors(octx, lm, HAND_CONNECTIONS, {color: '#00ff88', lineWidth: 2});
  drawLandmarks(octx, lm, {color: '#e94560', lineWidth: 1, radius: 3});

  // Contar dedos y ejecutar si el gesto cambió
  const n = contarDedos(lm);
  if (n > 0 && n !== ultimoGesto) {
    ultimoGesto = n;
    ejecutar(n);
  }
});

/* Cuenta los dedos extendidos de una mano.
   Estrategia:
     - Pulgar: compara distancias tip-vs-meñique.
     - Otros 4: compara altura del tip con la PIP. */
function contarDedos(lm) {
  const tips = [4, 8, 12, 16, 20];   // índices de las puntas
  const pips = [3, 6, 10, 14, 18];   // índices de las articulaciones PIP
  let count = 0;

  // --- Pulgar (heurística) ---
  const tt = lm[4], ti = lm[3], pm = lm[17];
  const dTip = Math.hypot(tt.x - pm.x, tt.y - pm.y);
  const dIp  = Math.hypot(ti.x - pm.x, ti.y - pm.y);
  if (dTip > dIp * 1.15) count++;

  // --- Otros cuatro dedos ---
  for (let i = 1; i < 5; i++) {
    if (lm[tips[i]].y < lm[pips[i]].y) count++;
  }
  return count;
}


/* ============================================================
   10) INICIALIZACIÓN
   Se ejecuta al cargar la página.
   ============================================================ */

window.addEventListener('load', async () => {
  // Valores por defecto en el formulario
  document.getElementById('funcion').value = 'x**2';
  document.getElementById('a').value = '0';
  document.getElementById('b').value = '2';
  await aplicar();

  // Mostrar panel de permiso (aún no se inicia la cámara)
  document.getElementById('panelPermiso').style.display = 'flex';
  document.getElementById('contenedorVideo').style.display = 'none';
  document.getElementById('estado').textContent = 'Esperando permiso de cámara...';

  // Consultar si ya se otorgó el permiso previamente
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const permiso = await navigator.permissions.query({ name: 'camera' });
      if (permiso.state === 'granted') {
        iniciarCamara();      // ya lo tenía: arranca directo
      } else if (permiso.state === 'denied') {
        mostrarErrorCamara(
          '🚫 Permiso bloqueado',
          'Bloqueaste la cámara previamente. Haz clic en el candado 🔒 de la barra de direcciones y permite la cámara, luego pulsa Reintentar.'
        );
      }
    } catch (e) {
      // Algunos navegadores no soportan consultar 'camera'
    }
  }
});


/* ============================================================
   11) ATAJOS DE TECLADO
   Se ignoran si el foco está en un input/select/textarea.
     - 1..5 → ejecuta la operación correspondiente
     - R    → reinicia todo
     - P    → pausa/reanuda la cámara
     - M    → alterna modo manual
   ============================================================ */
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

  // Escape → cerrar modal de ayuda
  if (e.key === 'Escape') {
    cerrarAyuda();
    return;
  }

  if (['1','2','3','4','5'].includes(e.key)) {
    ejecutar(parseInt(e.key));
  }
  if (e.key.toLowerCase() === 'r') {
    reiniciar();
  }
  if (e.key.toLowerCase() === 'p') {
    togglePausa();
  }
  if (e.key.toLowerCase() === 'm') {
    toggleManual();
  }
  // H → alterna abrir/cerrar el modal de ayuda
  if (e.key.toLowerCase() === 'h') {
    const m = document.getElementById('modalAyuda');
    if (m.classList.contains('abierto')) cerrarAyuda();
    else abrirAyuda();
  }
});