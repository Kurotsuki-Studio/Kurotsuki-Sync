import assert from 'node:assert';
import test, { describe } from 'node:test';
import { AwarenessManager } from '../src/awareness.js';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../src/utils.js';
import { KurotsukiSettings } from '../src/types.js';

describe('Plugin Logic: Encoders, Selectors, and Awareness', () => {
  test('Base64 <-> Uint8Array roundtrip', () => {
    const original = new Uint8Array([0, 1, 2, 3, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
    const b64 = uint8ArrayToBase64(original);
    const restored = base64ToUint8Array(b64);
    assert.deepStrictEqual(restored, original);

    // Empty array edge case
    const empty = new Uint8Array([]);
    assert.deepStrictEqual(base64ToUint8Array(uint8ArrayToBase64(empty)), empty);
  });

  test('Sync filtering: shouldSync logic', () => {
    // Helper function reproducing SyncEngine.shouldSync logic for isolated testing
    function shouldSync(path: string, settings: Pick<KurotsukiSettings, 'syncMode' | 'sharedFolders'>): boolean {
      if (!path) return false;
      if (path.startsWith('.obsidian/') || path.startsWith('.git/') || path.startsWith('.trash/')) {
        return false;
      }
      if (settings.syncMode === 'entire_vault') {
        return true;
      }
      const normalized = path.replace(/\\/g, '/');
      return settings.sharedFolders.some((folder) => {
        const cleanFolder = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!cleanFolder) return false;
        return normalized === cleanFolder || normalized.startsWith(cleanFolder + '/');
      });
    }

    // 1. Entire Vault Mode
    const entireVaultSettings = { syncMode: 'entire_vault' as const, sharedFolders: [] };
    assert.strictEqual(shouldSync('Notes/Work.md', entireVaultSettings), true);
    assert.strictEqual(shouldSync('root.md', entireVaultSettings), true);
    assert.strictEqual(shouldSync('.obsidian/plugins/test.js', entireVaultSettings), false);
    assert.strictEqual(shouldSync('.git/config', entireVaultSettings), false);
    assert.strictEqual(shouldSync('.trash/old.md', entireVaultSettings), false);

    // 2. Selective Mode
    const selectiveSettings = {
      syncMode: 'selective' as const,
      sharedFolders: ['Shared', 'Projects/Team', '/LeadingSlash/', 'TrailingSlash/'],
    };
    assert.strictEqual(shouldSync('Shared/MyNote.md', selectiveSettings), true);
    assert.strictEqual(shouldSync('Shared', selectiveSettings), true);
    assert.strictEqual(shouldSync('Projects/Team/Roadmap.md', selectiveSettings), true);
    assert.strictEqual(shouldSync('LeadingSlash/Doc.md', selectiveSettings), true);
    assert.strictEqual(shouldSync('TrailingSlash/Doc.md', selectiveSettings), true);
    assert.strictEqual(shouldSync('Personal/Private.md', selectiveSettings), false);
    assert.strictEqual(shouldSync('Secret.md', selectiveSettings), false);
    assert.strictEqual(shouldSync('', selectiveSettings), false);
  });

  test('AwarenessManager: state updates and peer tracking', () => {
    const userA = { id: 'usr_1', name: 'Alice', color: '#ff0000' };
    const awareness = new AwarenessManager(userA);

    assert.strictEqual(awareness.getLocalState().user.name, 'Alice');

    // Update active file
    awareness.updateActiveFile('Projects/Note.md');
    assert.strictEqual(awareness.getLocalState().activeFile, 'Projects/Note.md');

    // Update cursor
    awareness.updateCursor({ anchor: 5, head: 10 });
    assert.deepStrictEqual(awareness.getLocalState().cursor, { anchor: 5, head: 10 });

    // Handle remote awareness from Bob
    const userB = { id: 'usr_2', name: 'Bob', color: '#00ff00' };
    awareness.handleRemoteAwareness([
      {
        clientId: 999,
        user: userB,
        activeFile: 'Projects/Note.md',
        cursor: { anchor: 15, head: 15 },
        lastActive: Date.now(),
      },
    ]);

    const activePeers = awareness.getActivePeersForFile('Projects/Note.md');
    assert.strictEqual(activePeers.length, 1);
    assert.strictEqual(activePeers[0].user.name, 'Bob');

    // Peers in another file
    assert.strictEqual(awareness.getActivePeersForFile('Other.md').length, 0);

    // Remove peer
    awareness.removePeer(999);
    assert.strictEqual(awareness.getActivePeersForFile('Projects/Note.md').length, 0);

    awareness.destroy();
  });
});
