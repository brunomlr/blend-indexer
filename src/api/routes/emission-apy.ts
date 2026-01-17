import express, { Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';

const router = express.Router();

interface BackfillResult {
  success: boolean;
  output: string;
  error?: string;
  duration_ms: number;
}

/**
 * POST /api/emission-apy/backfill/lending
 * Run the lending emission APY backfill script
 */
router.post('/backfill/lending', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const scriptPath = path.resolve(__dirname, '../../../scripts/backfill-emission-apy.ts');

    const result = await new Promise<BackfillResult>((resolve) => {
      const outputLines: string[] = [];
      const errorLines: string[] = [];

      const child = spawn('npx', ['ts-node', scriptPath, '--lending', '--yes'], {
        cwd: path.resolve(__dirname, '../../../..'),
        env: { ...process.env },
      });

      child.stdout.on('data', (data) => {
        const text = data.toString();
        outputLines.push(text);
        console.log('[emission-apy]', text.trim());
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        errorLines.push(text);
        console.error('[emission-apy]', text.trim());
      });

      child.on('close', (code) => {
        const duration = Date.now() - startTime;
        if (code === 0) {
          resolve({
            success: true,
            output: outputLines.join(''),
            duration_ms: duration,
          });
        } else {
          resolve({
            success: false,
            output: outputLines.join(''),
            error: errorLines.join('') || `Process exited with code ${code}`,
            duration_ms: duration,
          });
        }
      });

      child.on('error', (err) => {
        resolve({
          success: false,
          output: outputLines.join(''),
          error: err.message,
          duration_ms: Date.now() - startTime,
        });
      });
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      output: '',
      error: (error as Error).message,
      duration_ms: Date.now() - startTime,
    });
  }
});

/**
 * POST /api/emission-apy/backfill/backstop
 * Run the backstop emission APY backfill script
 */
router.post('/backfill/backstop', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const scriptPath = path.resolve(__dirname, '../../../scripts/backfill-emission-apy.ts');

    const result = await new Promise<BackfillResult>((resolve) => {
      const outputLines: string[] = [];
      const errorLines: string[] = [];

      const child = spawn('npx', ['ts-node', scriptPath, '--backstop', '--yes'], {
        cwd: path.resolve(__dirname, '../../../..'),
        env: { ...process.env },
      });

      child.stdout.on('data', (data) => {
        const text = data.toString();
        outputLines.push(text);
        console.log('[emission-apy]', text.trim());
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        errorLines.push(text);
        console.error('[emission-apy]', text.trim());
      });

      child.on('close', (code) => {
        const duration = Date.now() - startTime;
        if (code === 0) {
          resolve({
            success: true,
            output: outputLines.join(''),
            duration_ms: duration,
          });
        } else {
          resolve({
            success: false,
            output: outputLines.join(''),
            error: errorLines.join('') || `Process exited with code ${code}`,
            duration_ms: duration,
          });
        }
      });

      child.on('error', (err) => {
        resolve({
          success: false,
          output: outputLines.join(''),
          error: err.message,
          duration_ms: Date.now() - startTime,
        });
      });
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      output: '',
      error: (error as Error).message,
      duration_ms: Date.now() - startTime,
    });
  }
});

export default router;
