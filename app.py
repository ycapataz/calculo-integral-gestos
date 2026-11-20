# ============================================================
# CÁLCULO INTEGRAL EN MOVIMIENTO - app.py
# ------------------------------------------------------------
# Servidor Flask que expone dos endpoints:
#
#   POST /api/curva     → devuelve puntos de f(x) y la malla
#                         paramétrica para el sólido 3D.
#   POST /api/calcular  → resuelve la integral según el gesto
#                         (n dedos) y devuelve el resultado
#                         numérico + las fórmulas en LaTeX.
#
# Tecnologías usadas:
#   - Flask: servidor web
#   - SymPy: cálculo simbólico (integración, derivadas, LaTeX)
#   - NumPy: arreglos numéricos
#   - SciPy: integración numérica (fallback cuando SymPy falla)
# ============================================================

from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
import sympy as sp
import numpy as np
import warnings

app = Flask(__name__)
CORS(app)  # permite peticiones desde el frontend en otro puerto

# Variable simbólica global: todas las funciones se expresan en x
x = sp.Symbol('x')


# ============================================================
# 1) PARSEO DE FUNCIONES
# Convierte el string que escribe el usuario (ej: "x^2") en una
# expresión simbólica de SymPy, habilitando funciones comunes.
# ============================================================
def parse_function(f_str):
    # Acepta `^` como alias de `**` (más natural para el usuario)
    f_str = f_str.replace('^', '**')

    # Diccionario de nombres permitidos dentro de la expresión
    local = {
        'x': x,
        'sin': sp.sin, 'cos': sp.cos, 'tan': sp.tan,
        'exp': sp.exp, 'log': sp.log, 'sqrt': sp.sqrt,
        'pi': sp.pi, 'e': sp.E, 'abs': sp.Abs
    }
    return sp.sympify(f_str, locals=local)


# ============================================================
# 2) INTEGRACIÓN HÍBRIDA (SIMBÓLICA + NUMÉRICA)
# Intenta resolver simbólicamente con SymPy. Si falla o tarda,
# cae al método numérico de SciPy (quad).
#
# Parámetro `forzar_numerico`:
#   - True  → va directo a SciPy (útil para integrales complejas
#             con |f(x)| o sqrt(1 + f'^2) que SymPy no resuelve
#             rápido).
#   - False → intenta simbólico primero.
# ============================================================
def integrate(expr, a, b, forzar_numerico=False):
    # --- Intento simbólico (rápido si funciona) ---
    if not forzar_numerico:
        try:
            val = sp.integrate(expr, (x, a, b))
            val = sp.N(val)
            # NUEVO: Detecta si el resultado simbólico es infinito o indeterminado
            if val in (sp.oo, -sp.oo, sp.zoo, sp.nan):
                return None
            # Aceptamos solo si es real y no contiene integrales sin resolver
            if val.is_real and not val.has(sp.Integral):
                return float(val)
        except Exception:
            pass

    # --- Fallback numérico con SciPy ---
    from scipy import integrate as sci
    from scipy.integrate import IntegrationWarning

    # Convertimos la expresión a función evaluable con numpy/math
    f = sp.lambdify(x, expr, modules=['numpy', 'math'])

    # Wrapper que garantiza retornar un float real
    def g(t):
        v = f(t)
        return float(np.real(v)) if np.iscomplexobj(v) else float(v)

    # NUEVO: Capturamos advertencias y errores numéricos
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        try:
            val, _ = sci.quad(g, a, b)
            # NUEVO: Si hay advertencia de divergencia, o el valor es infinito, NaN o NEGATIVO (áreas no son negativas)
            if any(issubclass(warn.category, IntegrationWarning) for warn in w):
                return None
            if np.isnan(val) or np.isinf(val) or val < 0:
                return None
            return float(val)
        except Exception:
            return None
# ============================================================
# 3) RUTA PRINCIPAL
# Sirve el HTML principal de la aplicación.
# ============================================================
@app.route('/')
def index():
    return render_template('index.html')


# ============================================================
# 4) ENDPOINT DE CÁLCULO
# Recibe: función, límites a-b, eje y número de dedos (n).
# Devuelve: resultado numérico + fórmulas en LaTeX + metadatos.
#
# Mapa de gestos:
#   n=1 → Área bajo la curva
#   n=2 → Volumen al rotar sobre el eje X
#   n=3 → Volumen al rotar sobre el eje Y
#   n=4 → Superficie de revolución
#   n=5 → Longitud de arco
# ============================================================
@app.route('/api/calcular', methods=['POST'])
def calcular():
    data = request.get_json()
    try:
        # --- Lectura y validación de parámetros ---
        f_str = data.get('funcion', 'x**2')
        a = float(data.get('a', 0))
        b = float(data.get('b', 1))
        eje = data.get('eje', 'x')     # no se usa directamente, pero se registra
        n = int(data.get('n', 1))

        # --- Parseo simbólico ---
        f = parse_function(f_str)      # expresión de f(x)
        df = sp.diff(f, x)             # derivada f'(x) para superficie y longitud

        # Convertimos f y df a LaTeX para incrustarlas en las fórmulas
        f_latex = sp.latex(f)
        df_latex = sp.latex(df)

        # NUEVO: Diccionarios con la información teórica solicitada
        tipos = {
            1: "Integral Definida (Área)",
            2: f"Volumen de Revolución (Eje {eje.upper()})",
            3: "Volumen de Revolución (Eje Y)",
            4: "Área Superficial de Revolución",
            5: "Longitud de Arco"
        }
        metodos = {
            1: "Teorema Fundamental del Cálculo",
            2: "Método de Discos / Arandelas",
            3: "Método de Capas Cilíndricas",
            4: "Fórmula de Superficie (S = 2π ∫ |f(x)|√(1+f'(x)²) dx)",
            5: "Fórmula de Longitud de Arco (L = ∫ √(1+f'(x)²) dx)"
        }

        # CORREGIDO: Función auxiliar para verificar si el límite existe
        def verificar_estado(valor):
            if valor is None:
                return "No existe / Divergente (Indeterminado)"
            return "Existe / Convergente (Límite finito)"

        # ----------------------------------------------------
        # CASO 1: ÁREA BAJO LA CURVA
        # A = ∫[a,b] |f(x)| dx
        # Devuelve además la "integral con signo" (sin valor absoluto).
        # ----------------------------------------------------
        if n == 1:
            integral_signo = integrate(f, a, b)
            area = integrate(sp.Abs(f), a, b, forzar_numerico=True)
            return jsonify({
                'tipo': 'area',
                'tipo_nombre': tipos[n],          # NUEVO
                'metodo': metodos[n],             # NUEVO
                'limite': verificar_estado(area), # NUEVO
                'formula': f"A = ∫[{a},{b}] |f(x)| dx",
                'latex': rf"A = \int_{{{a}}}^{{{b}}} \left| {f_latex} \right| \, dx",
                # CORREGIDO: Evalúa si es None antes de formatear a LaTeX
                'latex_valor': rf"A \approx {area:.4f} \text{{ u}}^2" if area is not None else r"\text{No evaluable (Indeterminado)}",
                'resultado': area,
                'integral_signo': integral_signo,
                'latex_signo': rf"\int_{{{a}}}^{{{b}}} {f_latex} \, dx \approx {integral_signo:.4f}" if integral_signo is not None else r"\text{No evaluable (Indeterminado)}",
                'unidades': 'u²'
            })

        # ----------------------------------------------------
        # CASO 2: VOLUMEN AL ROTAR SOBRE EL EJE X
        # V = π ∫[a,b] [f(x)]² dx
        # ----------------------------------------------------
        elif n == 2:
            v = integrate(sp.pi * f**2, a, b)
            return jsonify({
                'tipo': 'volumen_x',
                'tipo_nombre': tipos[n],          # NUEVO
                'metodo': metodos[n],             # NUEVO
                'limite': verificar_estado(v),    # NUEVO
                'formula': f"V = π ∫[{a},{b}] [f(x)]² dx",
                'latex': rf"V = \pi \int_{{{a}}}^{{{b}}} \left( {f_latex} \right)^2 \, dx",
                'latex_valor': rf"V \approx {v:.4f} \text{{ u}}^3" if v is not None else r"\text{No evaluable (Indeterminado)}",
                'resultado': v,
                'unidades': 'u³'
            })

        # ----------------------------------------------------
        # CASO 3: VOLUMEN AL ROTAR SOBRE EL EJE Y
        # Método de cascarones cilíndricos:
        # V = 2π ∫[a,b] |x| · |f(x)| dx
        # Usamos |x| porque el radio del cascarón siempre es positivo
        # (si usáramos x a secas, integrandos impares darían 0).
        # ----------------------------------------------------
        elif n == 3:
            v = integrate(2 * sp.pi * sp.Abs(x) * sp.Abs(f), a, b, forzar_numerico=True)
            return jsonify({
                'tipo': 'volumen_y',
                'tipo_nombre': tipos[n],          # NUEVO
                'metodo': metodos[n],             # NUEVO
                'limite': verificar_estado(v),    # NUEVO
                'formula': f"V = 2π ∫[{a},{b}] |x|·|f(x)| dx",
                'latex': rf"V = 2\pi \int_{{{a}}}^{{{b}}} |x| \left| {f_latex} \right| \, dx",
                'latex_valor': rf"V \approx {v:.4f} \text{{ u}}^3" if v is not None else r"\text{No evaluable (Indeterminado)}",
                'resultado': v,
                'unidades': 'u³'
            })

        # ----------------------------------------------------
        # CASO 4: SUPERFICIE DE REVOLUCIÓN
        # S = 2π ∫[a,b] |f(x)| · √(1 + [f'(x)]²) dx
        # Se fuerza numérico porque el integrando suele ser
        # demasiado complejo para SymPy.
        # ----------------------------------------------------
        elif n == 4:
            s = integrate(
                2 * sp.pi * sp.Abs(f) * sp.sqrt(1 + df**2),
                a, b,
                forzar_numerico=True
            )
            return jsonify({
                'tipo': 'superficie',
                'tipo_nombre': tipos[n],          # NUEVO
                'metodo': metodos[n],             # NUEVO
                'limite': verificar_estado(s),    # NUEVO
                'formula': f"S = 2π ∫[{a},{b}] |f(x)|·√(1+[f'(x)]²) dx",
                'latex': rf"S = 2\pi \int_{{{a}}}^{{{b}}} \left| {f_latex} \right| \sqrt{{1 + \left( {df_latex} \right)^2}} \, dx",
                'latex_valor': rf"S \approx {s:.4f} \text{{ u}}^2" if s is not None else r"\text{No evaluable (Indeterminado)}",
                'resultado': s,
                'unidades': 'u²'
            })

        # ----------------------------------------------------
        # CASO 5: LONGITUD DE ARCO
        # L = ∫[a,b] √(1 + [f'(x)]²) dx
        # ----------------------------------------------------
        elif n == 5:
            L = integrate(sp.sqrt(1 + df**2), a, b)
            return jsonify({
                'tipo': 'longitud',
                'tipo_nombre': tipos[n],          # NUEVO
                'metodo': metodos[n],             # NUEVO
                'limite': verificar_estado(L),    # NUEVO
                'formula': f"L = ∫[{a},{b}] √(1+[f'(x)]²) dx",
                'latex': rf"L = \int_{{{a}}}^{{{b}}} \sqrt{{1 + \left( {df_latex} \right)^2}} \, dx",
                'latex_valor': rf"L \approx {L:.4f} \text{{ u}}" if L is not None else r"\text{No evaluable (Indeterminado)}",
                'resultado': L,
                'unidades': 'u'
            })

        # Cualquier otro valor de n es inválido
        else:
            return jsonify({'error': 'Número de dedos inválido'}), 400

    # Cualquier excepción se devuelve como mensaje de error
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ============================================================
# 5) ENDPOINT DE CURVA
# Devuelve los datos necesarios para dibujar:
#   - La curva f(x) en 2D (x, y)
#   - La malla paramétrica del sólido 3D (u, theta, R)
#     donde R = |f(u)| es el radio de revolución.
# ============================================================
@app.route('/api/curva', methods=['POST'])
def curva():
    data = request.get_json()
    f_str = data.get('funcion', 'x**2')
    a = float(data.get('a', 0))
    b = float(data.get('b', 1))
    try:
        f = parse_function(f_str)
        fn = sp.lambdify(x, f, modules=['numpy', 'math'])

        # --- Curva 2D ---
        # Añadimos un margen del 30% para que la curva se vea completa
        margen = (b - a) * 0.3 or 1
        xs = np.linspace(a - margen, b + margen, 400)
        ys = fn(xs)
        # Los valores no finitos (inf, nan) se marcan como NaN
        ys = np.where(np.isfinite(ys), ys, np.nan)

        # --- Malla 3D ---
        # u: eje de integración (radio de revolución)
        # theta: ángulo alrededor del eje (0 a 2π)
        u = np.linspace(a, b, 40)
        th = np.linspace(0, 2 * np.pi, 40)
        U, T = np.meshgrid(u, th)      # malla 2D
        R = np.abs(fn(U))              # radio = |f(u)|

        return jsonify({
            'x': xs.tolist(),
            # None en lugar de NaN: JSON no soporta NaN estándar
            'y': [None if np.isnan(v) else float(v) for v in ys],
            'a': a, 'b': b,
            'u': u.tolist(),
            'theta': th.tolist(),
            # Reemplazamos NaN por 0 en la malla 3D para que Plotly no falle
            'R': np.nan_to_num(R, nan=0.0).tolist()
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ============================================================
# 6) ARRANQUE DEL SERVIDOR
# Solo se ejecuta si corremos `python app.py` directamente.
# - host 127.0.0.1: solo accesible desde la misma máquina
# - port 5000: puerto por defecto de Flask
# - debug=True: recarga automática al editar código
# ============================================================
if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=True)