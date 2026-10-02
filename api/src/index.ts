import { createServer } from 'node:http';
import { createDuskSocketServer } from './services/duskSocket';
import { stopDuskChangeStreams } from './services/duskChangeStream';
import { stopDuskSnapshotStreams } from './services/duskSnapshotStream';
import app from './app';
import pool from './config/database';
import { startActivityInvalidationListener, stopActivityInvalidationListener } from './services/activityInvalidationService';
import { startPoolInvalidationListener, stopPoolInvalidationListener } from './services/poolInvalidationService';
import { perfMetrics } from './utils/perfMetrics';
import { startDuskInvalidationListener, stopDuskInvalidationListener } from './services/duskInvalidationService';

if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');

const PORT = process.env.PORT || 3000;

const server = createServer(app);
const socketServer = createDuskSocketServer(server);

// Graceful shutdown function
const gracefulShutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down gracefully`);
  perfMetrics.stopReporting();
  socketServer.disconnectSockets(true);
  socketServer.engine.close();
  stopDuskChangeStreams();
  stopDuskSnapshotStreams();
  await stopActivityInvalidationListener();
  await stopPoolInvalidationListener();
  await stopDuskInvalidationListener();
  
  if (server) {
    server.close(async () => {
      console.log('HTTP server closed');
      await pool.end();
      console.log('Database pool closed');
      process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
      console.error('Forcing shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    await pool.end();
    process.exit(0);
  }
};

// Graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await startDuskInvalidationListener();
  } catch (error) {
    console.error('Dusk invalidation listener will reconnect:', error);
  }
  try {
    await startActivityInvalidationListener();
  } catch (error) {
    console.error('Failed to start activity invalidation listener:', error);
  }
  try {
    await startPoolInvalidationListener();
  } catch (error) {
    console.error('Failed to start pool invalidation listener:', error);
  }
});

process.on('unhandledRejection', (err: any) => {
  console.error('Unhandled Promise Rejection:', err);
  socketServer.disconnectSockets(true);
  socketServer.engine.close();
  stopDuskChangeStreams();
  stopDuskSnapshotStreams();
  if (server) {
    server.close(async () => {
      await pool.end();
      process.exit(1);
    });
  } else {
    pool.end().then(() => process.exit(1));
  }
});

export default server;
