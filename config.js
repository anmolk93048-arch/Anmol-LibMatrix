/* Anmol LibMatrix — one place to point every portal at the backend (Render).
   Change API_BASE only if your Render URL changes. */
window.ANMOL_CONFIG = {
  API_BASE: 'https://anmol-libmatrix.onrender.com/api',
  HOME: 'index.html'
};
window.SHDL_API_BASE = window.SHDL_API_BASE || window.ANMOL_CONFIG.API_BASE; // used by every portal page
window.SHDL_HOME_URL = window.SHDL_HOME_URL || window.ANMOL_CONFIG.HOME;     // logout target
try { // drop anything cached from older backends
  ['shdl_api_base','anmol_api_base','SHDL_API_BASE','api_base'].forEach(function(k){ var v=localStorage.getItem(k); if(v && /library-backend-4efk|run\.app|vercel\.app/.test(v)) localStorage.removeItem(k); });
} catch (e) {}
