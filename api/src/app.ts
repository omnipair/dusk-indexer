import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { observeRequest, requestId } from './utils/metrics';
import dotenv from 'dotenv';
import routes from './routes';
import { errorHandler, notFound } from './middleware/errorHandler';
import { perfMetrics } from './utils/perfMetrics';

dotenv.config();

const app = express();

app.set('trust proxy', 2);

app.use('/docs-assets', express.static(path.join(__dirname, '../public')));

app.use(compression());
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string') return cfIp;
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
  message: { success: false, error: 'Too many requests, please try again later.' },
});
app.use(limiter);

/**
 * Structured request logging and metrics.
 *
 * One line per request, as JSON, because these logs are read by a machine far
 * more often than by a person and a grep-friendly format stops being either
 * once fields start containing spaces. The request id is echoed in a header so
 * a user reporting a failure can quote something that finds the exact line.
 *
 * Latency is measured around the whole response, not the handler, so it
 * includes serialization — which is where a large market list actually spends
 * its time.
 */
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  const id = requestId();
  res.setHeader('x-request-id', id);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    // The matched route, never the concrete path: keying metrics on
    // /markets/<address> grows a series per market and is useless in a day.
    const route = `${req.method} ${req.route?.path ?? req.baseUrl ?? req.path}`;
    observeRequest(route, res.statusCode, durationMs);
    if (res.statusCode >= 400 || durationMs > 2_000) {
      console.log(
        JSON.stringify({
          durationMs: Math.round(durationMs),
          level: res.statusCode >= 500 ? 'error' : 'warn',
          path: req.originalUrl,
          requestId: id,
          status: res.statusCode,
        }),
      );
    }
  });
  next();
});

//safety for future proofing
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

perfMetrics.ensureReporting(60_000);

app.use('/', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
