// Función de Vercel: delega en el mismo manejador que usa el servidor local.
import { handleApi } from '../../server/server.js';

export default function handler(req, res) {
  return handleApi(req, res, '/api/campus/file');
}
