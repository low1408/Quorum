import fs from 'fs';
import path from 'path';

// Define a stable log path in the workspace
const logPath = '/home/harry/Documents/Github-Projects/quorum-llm-council/quorum-mcp.log';

function writeLog(level: string, ...args: any[]) {
  try {
    const timestamp = new Date().toISOString();
    const message = args
      .map(arg => {
        if (arg instanceof Error) {
          return arg.stack || arg.message;
        }
        return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg);
      })
      .join(' ');
    fs.appendFileSync(logPath, `[${timestamp}] [${level}] ${message}\n`);
  } catch {
    // Fail silently to prevent process crash
  }
}

// Redirect all standard console methods to the file
console.log = (...args: any[]) => writeLog('INFO', ...args);
console.info = (...args: any[]) => writeLog('INFO', ...args);
console.warn = (...args: any[]) => writeLog('WARN', ...args);
console.debug = (...args: any[]) => writeLog('DEBUG', ...args);
console.error = (...args: any[]) => writeLog('ERROR', ...args);
