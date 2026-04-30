"""
Dashboard interactivo + panel de control.

Uso local:
    streamlit run dashboard.py

Funciones:
- 5 vistas (heatmap, tendencia, ranking, alertas, salud)
- Botón "Relevar ahora" en la sidebar
- Banner de alertas activas arriba
- Configuración de umbral de alertas
- Historial de corridas
"""
import os
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import streamlit as st
import altair as alt

from normalizador import corte_pretty


DB_PATH = Path(__file__).parent / "data" / "precios.db"
PROJECT_DIR = Path(__file__).parent


# ─── Carga de datos (cacheado) ────────────────────────────────────────────

@st.cache_data(ttl=60)
def cargar_precios(dias: int = 90) -> pd.DataFrame:
    if not DB_PATH.exists():
        return pd.DataFrame()
    fecha_min = (datetime.now() - timedelta(days=dias)).strftime("%Y-%m-%d")
    with sqlite3.connect(DB_PATH) as con:
        df = pd.read_sql_query(
            """
            SELECT fecha, carniceria, segmento, corte_normalizado,
                   AVG(precio_kg) AS precio_kg
            FROM precios
            WHERE fecha >= ?
            GROUP BY fecha, carniceria, corte_normalizado
            """,
            con, params=(fecha_min,),
        )
    if not df.empty:
        df["fecha"] = pd.to_datetime(df["fecha"])
        df["corte"] = df["corte_normalizado"].apply(corte_pretty)
    return df


@st.cache_data(ttl=60)
def cargar_corridas() -> pd.DataFrame:
    if not DB_PATH.exists():
        return pd.DataFrame()
    with sqlite3.connect(DB_PATH) as con:
        try:
            df = pd.read_sql_query(
                "SELECT * FROM corridas ORDER BY fecha DESC, carniceria",
                con,
            )
        except Exception:
            return pd.DataFrame()
    if not df.empty:
        df["fecha"] = pd.to_datetime(df["fecha"])
    return df


def detectar_alertas_df(df: pd.DataFrame, umbral_pct: float) -> pd.DataFrame:
    fechas = sorted(df["fecha"].unique(), reverse=True)
    if len(fechas) < 2:
        return pd.DataFrame()
    f_act, f_ant = fechas[0], fechas[1]
    act = df[df["fecha"] == f_act].set_index(["carniceria", "corte"])["precio_kg"]
    ant = df[df["fecha"] == f_ant].set_index(["carniceria", "corte"])["precio_kg"]
    comunes = act.index.intersection(ant.index)
    if not len(comunes):
        return pd.DataFrame()
    out = pd.DataFrame({
        "Hoy": act.loc[comunes].values,
        "Anterior": ant.loc[comunes].values,
    }, index=comunes)
    out["pct"] = (out["Hoy"] - out["Anterior"]) / out["Anterior"] * 100
    out = out[out["pct"].abs() >= umbral_pct].sort_values("pct", key=lambda s: s.abs(), ascending=False)
    return out


# ─── Ejecutar relevamiento desde la web ───────────────────────────────────

def correr_relevamiento_async(opciones: list[str], log_path: Path):
    """Lanza run.py en background, escribe stdout a un log file."""
    cmd = [sys.executable, "run.py", "--no-notif", "--no-graficos"] + opciones
    with open(log_path, "w") as f:
        f.write(f"$ {' '.join(cmd)}\n\n")
        f.flush()
        proc = subprocess.Popen(
            cmd, cwd=PROJECT_DIR,
            stdout=f, stderr=subprocess.STDOUT,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        proc.wait()
        f.write(f"\n--- exit code: {proc.returncode} ---\n")


def lanzar_relevamiento(scrapers: list[str]) -> Path:
    log_path = PROJECT_DIR / f"reports/_relevamiento_en_curso.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    opciones = []
    if len(scrapers) == 1:
        opciones = ["--solo", scrapers[0]]
    elif scrapers:
        # run.py no soporta lista, así que si elegiste varios usamos --todos
        opciones = ["--todos"]
    t = threading.Thread(
        target=correr_relevamiento_async,
        args=(opciones, log_path),
        daemon=True,
    )
    t.start()
    return log_path


# ─── UI ───────────────────────────────────────────────────────────────────

st.set_page_config(
    page_title="Relevador de carnes 🥩",
    page_icon="🥩",
    layout="wide",
)

st.title("🥩 Relevador de precios de carne")
st.caption("Panel de control + visualización. Toda la lógica está acá, sin terminal.")

df = cargar_precios(dias=180)


# ─── Sidebar: control panel + filtros ─────────────────────────────────────

with st.sidebar:
    st.header("⚡ Control")

    SCRAPERS_DISPONIBLES = [
        "sepa", "carrefour_html", "jumbo_html", "dia_html",
        "la_anonima", "las_heras", "res", "josimar",
        "coto", "carrefour", "dia", "vea", "changomas",
        "jumbo", "disco", "maxiconsumo", "ipcva",
    ]
    seleccion = st.multiselect(
        "Scrapers a correr",
        SCRAPERS_DISPONIBLES,
        default=["sepa"],
        help="SEPA solo basta (cubre ~50 cadenas). Sumá otros si querés data extra.",
    )

    if st.button("🚀 Relevar ahora", type="primary", width="stretch"):
        if not seleccion:
            st.error("Elegí al menos un scraper.")
        else:
            log_path = lanzar_relevamiento(seleccion)
            st.session_state["relevamiento_activo"] = True
            st.session_state["log_path"] = str(log_path)
            st.success(f"✅ Relevamiento lanzado ({len(seleccion)} scrapers). Mirá el log abajo.")

    if st.session_state.get("relevamiento_activo"):
        log_path = Path(st.session_state["log_path"])
        if log_path.exists():
            log_text = log_path.read_text()[-3000:]
            with st.expander("📋 Log en vivo (últimas líneas)", expanded=True):
                st.code(log_text, language="bash")
            if "--- exit code:" in log_text:
                st.session_state["relevamiento_activo"] = False
                st.cache_data.clear()
                st.success("✅ Terminado. Refrescá los datos abajo.")
                if st.button("🔄 Refrescar dashboard"):
                    st.rerun()

    st.divider()

    st.header("⚙️ Configuración")
    umbral_alertas = st.slider("Umbral de alerta (%)", 1.0, 20.0, 5.0, 0.5)
    st.session_state["umbral_alertas"] = umbral_alertas

    st.divider()

    st.header("🔍 Filtros")
    if not df.empty:
        segmentos_disponibles = sorted(df["segmento"].unique())
        segmentos = st.multiselect(
            "Segmento", segmentos_disponibles, default=segmentos_disponibles
        )
        dias_atras = st.slider("Días de historia", 7, 180, 60)
        incluir_benchmark = st.checkbox("Incluir benchmark", value=True)
    else:
        segmentos = []
        dias_atras = 60
        incluir_benchmark = True


if df.empty:
    st.warning(
        "No hay datos en la base. Apretá 🚀 **Relevar ahora** en la sidebar "
        "para hacer el primer relevamiento, o corré `python seed_demo.py` "
        "para cargar datos sintéticos de prueba."
    )
    st.stop()


df_filtrado = df[df["segmento"].isin(segmentos)].copy() if segmentos else df.copy()
if not incluir_benchmark:
    df_filtrado = df_filtrado[df_filtrado["segmento"] != "benchmark"]
fecha_min = datetime.now() - timedelta(days=dias_atras)
df_filtrado = df_filtrado[df_filtrado["fecha"] >= fecha_min]

if df_filtrado.empty:
    st.info("Sin datos con esos filtros.")
    st.stop()

ultima_fecha = df_filtrado["fecha"].max()
df_hoy = df_filtrado[df_filtrado["fecha"] == ultima_fecha]


# ─── Banner de alertas activas ────────────────────────────────────────────

alertas_df = detectar_alertas_df(df_filtrado, st.session_state.get("umbral_alertas", 5.0))
if not alertas_df.empty:
    n_subas = (alertas_df["pct"] > 0).sum()
    n_bajas = (alertas_df["pct"] < 0).sum()
    st.error(
        f"🚨 **{len(alertas_df)} alertas activas** "
        f"(🔺 {n_subas} subas · 🔻 {n_bajas} bajas) — ver detalle en pestaña *Alertas*"
    )


# ─── KPIs ─────────────────────────────────────────────────────────────────

col1, col2, col3, col4 = st.columns(4)
col1.metric("Última corrida", ultima_fecha.strftime("%d/%m/%Y"))
col2.metric("Carnicerías hoy", df_hoy["carniceria"].nunique())
col3.metric("Cortes distintos", df_hoy["corte_normalizado"].nunique())
col4.metric("Productos relevados", len(df_hoy))


# ─── Tabs ─────────────────────────────────────────────────────────────────

tab_heatmap, tab_tendencia, tab_ranking, tab_alertas, tab_salud = st.tabs([
    "📊 Heatmap actual",
    "📈 Tendencia",
    "🏆 Ranking por corte",
    "🚨 Alertas",
    "❤️  Salud scrapers",
])


with tab_heatmap:
    st.subheader(f"Precios actuales por cadena × corte ({ultima_fecha:%d/%m/%Y})")
    pivot = df_hoy.pivot_table(
        index="corte", columns="carniceria", values="precio_kg", aggfunc="mean"
    )
    if not pivot.empty:
        chart = alt.Chart(df_hoy).mark_rect().encode(
            x=alt.X("carniceria:N", title="Cadena"),
            y=alt.Y("corte:N", title="Corte"),
            color=alt.Color("precio_kg:Q",
                            scale=alt.Scale(scheme="redyellowgreen", reverse=True),
                            title="$/kg"),
            tooltip=[
                alt.Tooltip("carniceria", title="Cadena"),
                alt.Tooltip("corte", title="Corte"),
                alt.Tooltip("precio_kg", title="$/kg", format=",.0f"),
                alt.Tooltip("segmento", title="Segmento"),
            ],
        ).properties(height=520)
        st.altair_chart(chart, width="stretch")

        with st.expander("Ver tabla pivot"):
            st.dataframe(
                pivot.style.format("${:,.0f}").background_gradient(
                    cmap="RdYlGn_r", axis=None
                ),
                width="stretch",
            )
    else:
        st.info("Sin datos para el heatmap.")


with tab_tendencia:
    cortes = sorted(df_filtrado["corte"].unique())
    corte_sel = st.selectbox("Corte a analizar", cortes,
                             index=cortes.index("Asado") if "Asado" in cortes else 0)
    df_corte = df_filtrado[df_filtrado["corte"] == corte_sel]

    if df_corte.empty or df_corte["fecha"].nunique() < 2:
        st.info("Faltan datos históricos para este corte.")
    else:
        chart = alt.Chart(df_corte).mark_line(point=True).encode(
            x=alt.X("fecha:T", title=""),
            y=alt.Y("precio_kg:Q", title="$/kg", axis=alt.Axis(format=",.0f")),
            color=alt.Color("carniceria:N", title="Cadena"),
            tooltip=[
                alt.Tooltip("fecha:T", title="Fecha", format="%d/%m/%Y"),
                alt.Tooltip("carniceria", title="Cadena"),
                alt.Tooltip("precio_kg", title="$/kg", format=",.0f"),
            ],
        ).properties(height=420, title=f"Tendencia {corte_sel}")
        st.altair_chart(chart, width="stretch")

        st.markdown("**Variación en el período:**")
        rows = []
        for carn, grupo in df_corte.groupby("carniceria"):
            grupo = grupo.sort_values("fecha")
            primero, ultimo = grupo.iloc[0], grupo.iloc[-1]
            if primero["precio_kg"] > 0:
                pct = (ultimo["precio_kg"] - primero["precio_kg"]) / primero["precio_kg"] * 100
                rows.append({
                    "Cadena": carn,
                    "Inicio": f"${primero['precio_kg']:,.0f}",
                    "Hoy": f"${ultimo['precio_kg']:,.0f}",
                    "Variación %": round(pct, 1),
                })
        if rows:
            st.dataframe(pd.DataFrame(rows).sort_values("Variación %"),
                         width="stretch", hide_index=True)


with tab_ranking:
    st.subheader("Carnicería más barata por corte (último relevamiento)")
    ranking = (df_hoy.groupby("corte")
               .apply(lambda g: g.nsmallest(3, "precio_kg")[["carniceria", "precio_kg"]])
               .reset_index(level=1, drop=True)
               .reset_index())
    if not ranking.empty:
        ranking["precio_kg"] = ranking["precio_kg"].apply(lambda x: f"${x:,.0f}")
        ranking.columns = ["Corte", "Cadena", "$/kg"]
        st.dataframe(ranking, width="stretch", hide_index=True)


with tab_alertas:
    umbral = st.session_state.get("umbral_alertas", 5.0)
    st.subheader(f"Variaciones >{umbral}% vs el relevamiento anterior")
    if alertas_df.empty:
        st.success(f"Sin variaciones >{umbral}% — todo estable.")
    else:
        out = alertas_df.copy().reset_index()
        out["Hoy"] = out["Hoy"].apply(lambda x: f"${x:,.0f}")
        out["Anterior"] = out["Anterior"].apply(lambda x: f"${x:,.0f}")
        out["pct"] = out["pct"].round(1)
        out.columns = ["Cadena", "Corte", "Hoy", "Anterior", "Variación %"]
        st.dataframe(out, width="stretch", hide_index=True)


with tab_salud:
    st.subheader("Estado de los scrapers")
    df_corr = cargar_corridas()
    if df_corr.empty:
        st.info("Sin historial de corridas todavía.")
    else:
        ultimas = df_corr.sort_values("fecha").groupby("carniceria").tail(1)
        ultimas = ultimas[["fecha", "carniceria", "cortes_relevados",
                           "duracion_s", "sospechoso", "error"]]
        ultimas["estado"] = ultimas.apply(
            lambda r: "❌ falló" if r["error"]
            else ("⚠️ sospechoso" if r["sospechoso"] else "✅ ok"),
            axis=1,
        )
        ultimas = ultimas[["estado", "carniceria", "fecha",
                           "cortes_relevados", "duracion_s", "error"]]
        ultimas.columns = ["Estado", "Cadena", "Última corrida",
                           "Cortes", "Duración (s)", "Error"]
        st.dataframe(ultimas, width="stretch", hide_index=True)


st.caption(
    f"Datos: {DB_PATH.name} · {len(df)} filas en los últimos 180 días "
    f"· Última actualización: {ultima_fecha:%d/%m/%Y %H:%M}"
)
