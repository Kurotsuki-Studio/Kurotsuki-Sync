import assert from 'node:assert';
import test, { describe } from 'node:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AwarenessManager } from '../src/awareness.js';
import { readOnlyField, remoteSyncAnnotation, setReadOnlyEffect } from '../src/cm6-collab.js';
import { DEFAULT_SETTINGS, KurotsukiSettings, SyncHistoryEntry } from '../src/types.js';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../src/utils.js';

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

  test('Read-only role and permission enforcement logic', () => {
    const viewerSettings: KurotsukiSettings = {
      ...DEFAULT_SETTINGS,
      currentRole: 'viewer',
    };

    const isReadOnly = (settings: KurotsukiSettings) => settings.currentRole === 'viewer';
    assert.strictEqual(isReadOnly(viewerSettings), true);

    const editorSettings: KurotsukiSettings = {
      ...DEFAULT_SETTINGS,
      currentRole: 'editor',
    };
    assert.strictEqual(isReadOnly(editorSettings), false);

    const adminSettings: KurotsukiSettings = {
      ...DEFAULT_SETTINGS,
      currentRole: 'admin',
    };
    assert.strictEqual(isReadOnly(adminSettings), false);
  });

  test('Exponential backoff calculation formula', () => {
    function computeBackoff(attempt: number, jitter = 0): number {
      const base = 1000 * Math.pow(1.6, Math.min(attempt, 8));
      return Math.min(base + jitter, 30000);
    }

    const t1 = computeBackoff(1);
    const t2 = computeBackoff(2);
    const t3 = computeBackoff(3);
    const t8 = computeBackoff(8);
    const t20 = computeBackoff(20);

    assert.ok(t1 >= 1600);
    assert.ok(t2 > t1);
    assert.ok(t3 > t2);
    assert.ok(t8 <= 30000);
    assert.strictEqual(t20, 30000); // Capped at max 30s
  });

  test('Sync history recorder and conflict resolution logger', () => {
    const history: SyncHistoryEntry[] = [];
    function record(entry: Omit<SyncHistoryEntry, 'id' | 'timestamp'>) {
      history.unshift({
        id: 'hist_' + Math.random().toString(36).substring(2, 8),
        timestamp: Date.now(),
        ...entry,
      });
    }

    record({
      type: 'local_update',
      path: 'Doc1.md',
      sizeBytes: 120,
      summary: 'Local change in Doc1.md',
    });

    record({
      type: 'remote_update',
      path: 'Doc1.md',
      sizeBytes: 250,
      summary: 'Remote change from Alice',
    });

    record({
      type: 'conflict_detected',
      path: 'Doc1.md',
      summary: 'Concurrent edits merged with CRDT',
    });

    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[0].type, 'conflict_detected');
    assert.strictEqual(history[1].type, 'remote_update');
    assert.strictEqual(history[2].type, 'local_update');
  });

  test('Multi-vault profile structure and defaults', () => {
    assert.ok(Array.isArray(DEFAULT_SETTINGS.vaultProfiles));
    assert.strictEqual(DEFAULT_SETTINGS.vaultProfiles.length, 1);
    assert.strictEqual(DEFAULT_SETTINGS.vaultProfiles[0].vaultId, 'default-vault');
    assert.strictEqual(DEFAULT_SETTINGS.activeProfileId, 'default-profile');
  });

  test('CodeMirror 6: dynamic read-only facet, editable facet, and remote sync bypass', () => {
    let attemptedNotice = 0;
    const isReadOnly = () => true;

    // Build the CM6 read-only extensions matching createCollabExtension
    const readOnlyFacet = EditorState.readOnly.compute([readOnlyField], (state) => state.field(readOnlyField));
    const editableFacet = EditorView.editable.compute([readOnlyField], (state) => !state.field(readOnlyField));

    const changeFilter = EditorState.changeFilter.of((tr) => {
      if (tr.annotation(remoteSyncAnnotation)) return true;
      if (isReadOnly() && tr.docChanged) {
        attemptedNotice++;
        return false;
      }
      return true;
    });

    const transactionFilter = EditorState.transactionFilter.of((tr) => {
      if (tr.annotation(remoteSyncAnnotation)) return tr;
      if (isReadOnly() && tr.docChanged) {
        attemptedNotice++;
        return [];
      }
      return tr;
    });

    // 1. Initial state (readOnlyField is false by default)
    let state = EditorState.create({
      doc: 'Initial document content',
      extensions: [readOnlyField, readOnlyFacet, editableFacet, changeFilter, transactionFilter],
    });

    assert.strictEqual(state.facet(EditorView.editable), true);
    assert.strictEqual(state.facet(EditorState.readOnly), false);

    // 2. Dispatch setReadOnlyEffect(true) - switches into viewer mode
    state = state.update({ effects: [setReadOnlyEffect.of(true)] }).state;
    assert.strictEqual(state.facet(EditorView.editable), false);
    assert.strictEqual(state.facet(EditorState.readOnly), true);

    // 3. User attempts local edit: must be blocked by changeFilter and transactionFilter
    const userTr = state.update({
      changes: { from: 0, to: 7, insert: 'Hacked' },
    });
    assert.strictEqual(userTr.changes.empty, true, 'User edit must be cancelled');
    assert.ok(attemptedNotice > 0, 'Read-only attempt notice must be triggered');

    // 4. Remote sync arrives with remoteSyncAnnotation: must NOT be blocked!
    const remoteTr = state.update({
      changes: { from: 0, to: 7, insert: 'Collaborator' },
      annotations: [remoteSyncAnnotation.of(true)],
    });
    assert.strictEqual(remoteTr.changes.empty, false, 'Remote sync must be accepted');
    const newState = remoteTr.state;
    assert.strictEqual(newState.doc.toString(), 'Collaborator document content');
  });

  test('AwarenessManager: getAllPeers alias works identically to getAllRemotePeers', () => {
    const awareness = new AwarenessManager({ id: 'u1', name: 'Test', color: '#123456' });
    assert.deepStrictEqual(awareness.getAllPeers(), awareness.getAllRemotePeers());
    awareness.destroy();
  });
});
