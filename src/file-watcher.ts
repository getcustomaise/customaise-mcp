/**
 * FileWatcher — watches a synced scripts directory for .user.js changes
 * and auto-exports modified files back to Customaise.
 *
 * Activated after sync_scripts creates the manifest.
 * Uses native fs.watch() for reliable cross-platform file watching.
 */

import { watch, type FSWatcher, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Bridge } from './bridge.js';

const LOG_PREFIX = '[customaise-mcp:watcher]';

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private bridge: Bridge;
  private directory: string = '';

  /** filenames we recently wrote — mute window to prevent re-export loops */
  private muteSet = new Set<string>();
  private muteTimeoutMs = 1000;

  /** debounce timers per file */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs = 500;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  /**
   * Start watching a directory for .user.js changes.
   * Replaces any previous watcher.
   */
  start(directory: string): void {
    // Stop previous watcher if any
    this.stop();

    this.directory = directory;

    const manifestPath = join(directory, '.customaise-manifest.json');
    if (!existsSync(manifestPath)) {
      console.error(`${LOG_PREFIX} No manifest found at ${manifestPath}. Run sync_scripts first.`);
      return;
    }

    console.error(`${LOG_PREFIX} Watching ${directory} for .user.js changes`);

    // Use native fs.watch on the directory
    this.watcher = watch(directory, (eventType, filename) => {
      if (!filename || !filename.endsWith('.user.js')) return;
      if (eventType === 'change' || eventType === 'rename') {
        const filePath = join(directory, filename);
        if (existsSync(filePath)) {
          this.handleFileChange(filePath);
        }
      }
    });

    this.watcher.on('error', (error: Error) => {
      console.error(`${LOG_PREFIX} Watcher error:`, error.message);
    });
  }

  /**
   * Mute a filename to prevent re-export after MCP-initiated writes.
   */
  muteFile(fileName: string): void {
    this.muteSet.add(fileName);
    setTimeout(() => {
      this.muteSet.delete(fileName);
    }, this.muteTimeoutMs);
  }

  /**
   * Stop the file watcher.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.error(`${LOG_PREFIX} Watcher stopped`);
    }
    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();
    this.muteSet.clear();
  }

  private handleFileChange(filePath: string): void {
    const fileName = basename(filePath);

    // Skip if this file is in the mute window (MCP-initiated write)
    if (this.muteSet.has(fileName)) {
      return;
    }

    // Debounce — IDEs may trigger multiple save events
    const existing = this.debounceTimers.get(fileName);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      fileName,
      setTimeout(() => {
        this.debounceTimers.delete(fileName);
        this.exportFile(filePath, fileName);
      }, this.debounceMs)
    );
  }

  private async exportFile(filePath: string, fileName: string): Promise<void> {
    try {
      // Read manifest to find scriptId
      const manifestPath = join(this.directory, '.customaise-manifest.json');
      if (!existsSync(manifestPath)) return;

      const manifest: Record<string, string> = JSON.parse(
        readFileSync(manifestPath, 'utf-8')
      );

      const scriptId = manifest[fileName];
      if (!scriptId) {
        console.error(`${LOG_PREFIX} No scriptId in manifest for ${fileName} — skipping`);
        return;
      }

      // Read file content
      const code = readFileSync(filePath, 'utf-8');
      if (!code.trim()) return;

      console.error(`${LOG_PREFIX} Auto-exporting ${fileName} → ${scriptId}`);

      // Send to extension via bridge. Auto-export from the file
      // watcher counts toward the user's MCP cap (ARD §4.1: every
      // successful tool dispatch counts) — same +1 as if the IDE had
      // called export_script directly. dispatchTool throws McpError
      // (cap-exceeded, etc.); on cap-exceeded we surface the message
      // to stderr but otherwise let the watcher keep running so a
      // later cap reset / tier upgrade resumes auto-sync without a
      // server restart.
      const result = await this.bridge.dispatchTool('export_script', {
        code,
        scriptId,
      }) as { success?: boolean; error?: string };

      if (result?.success) {
        console.error(`${LOG_PREFIX} ✓ ${fileName} exported successfully`);
      } else {
        console.error(`${LOG_PREFIX} ✗ ${fileName} export failed: ${result?.error || 'unknown'}`);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Error exporting ${fileName}:`, error instanceof Error ? error.message : error);
    }
  }
}
