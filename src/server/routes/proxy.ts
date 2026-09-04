/**
 * The OpenAI-shaped surface, for tools that speak that and nothing else.
 */
import { Router } from 'express';
import { handleChatCompletion } from '../../proxy/openai.js';
import { emitDecision } from '../events.js';
import { asyncRoute } from '../http.js';

export const proxyRoutes = Router();

proxyRoutes.get('/v1/models', (_req, res) => {
  res.json({ object: 'list', data: [{ id: 'warden', object: 'model', owned_by: 'warden' }] });
});

proxyRoutes.post('/v1/chat/completions', asyncRoute((req, res) => handleChatCompletion(req, res, emitDecision)));
