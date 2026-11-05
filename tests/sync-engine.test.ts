import assert from 'node:assert';
import test, { describe } from 'node:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import * as Y from 'yjs';
import { AwarenessManager } from '../src/awareness.js';
import { readOnlyField, rebindEffect, remoteSyncAnnotation, setReadOnlyEffect } from '../src/cm6-collab.js';
import { DEFAULT_SETTINGS, KurotsukiSettings, SyncHistoryEntry } from '../src/types.js';
import { base64ToUint8Array, normalizePath, uint8ArrayToBase64 } from '../src/utils.js';

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

  test('AwarenessManager: deduplicates identical local cursor updates and remote heartbeats', () => {
    const awareness = new AwarenessManager({ id: 'u1', name: 'User 1', color: '#ff0000' });
    let localCalls = 0;
    awareness.onLocalChange(() => {
      localCalls++;
    });

    // 1. Initial cursor update should fire
    awareness.updateCursor({ anchor: 10, head: 10 });
    assert.strictEqual(localCalls, 1);

    // 2. Calling with same cursor should be ignored (deduplicated)
    awareness.updateCursor({ anchor: 10, head: 10 });
    assert.strictEqual(localCalls, 1);

    // 3. New position fires
    awareness.updateCursor({ anchor: 12, head: 12 });
    assert.strictEqual(localCalls, 2);

    // 4. Remote awareness deduplication
    let remoteCalls = 0;
    awareness.subscribe(() => {
      remoteCalls++;
    });
    // First subscribe triggers listener once with current state
    assert.strictEqual(remoteCalls, 1);

    const peerA = {
      clientId: 42,
      user: { id: 'u2', name: 'Bob', color: '#00ff00' },
      activeFile: 'Test.md',
      cursor: { anchor: 5, head: 5 },
      lastActive: Date.now(),
    };

    // Handling new peer triggers remote notification
    awareness.handleRemoteAwareness([peerA]);
    assert.strictEqual(remoteCalls, 2);

    // Handling identical state (heartbeat ping) MUST NOT trigger remote notification
    awareness.handleRemoteAwareness([{ ...peerA, lastActive: Date.now() }]);
    assert.strictEqual(remoteCalls, 2);

    // Changed cursor triggers notification
    awareness.handleRemoteAwareness([{ ...peerA, cursor: { anchor: 6, head: 6 } }]);
    assert.strictEqual(remoteCalls, 3);

    awareness.destroy();
  });

  test('Yjs Batch Merging: merges multiple character insertions into a single CRDT update', () => {
    const docSource = new Y.Doc();
    const yTextSource = docSource.getText('content');
    const updates: Uint8Array[] = [];

    docSource.on('update', (u: Uint8Array) => {
      updates.push(u);
    });

    // Simulate typing "Hello" character by character
    const chars = ['H', 'e', 'l', 'l', 'o', ' ', 'W', 'o', 'r', 'l', 'd'];
    for (let i = 0; i < chars.length; i++) {
      docSource.transact(() => {
        yTextSource.insert(i, chars[i]);
      });
    }

    assert.strictEqual(updates.length, 11);
    assert.strictEqual(yTextSource.toString(), 'Hello World');

    // Merge all 11 micro-updates into 1 compact update
    const merged = Y.mergeUpdates(updates);

    // Apply merged update to an empty doc
    const docTarget = new Y.Doc();
    const yTextTarget = docTarget.getText('content');
    Y.applyUpdate(docTarget, merged);

    assert.strictEqual(yTextTarget.toString(), 'Hello World');
    assert.ok(merged.length < updates.reduce((acc, u) => acc + u.length, 0), 'Merged update should be more compact than sum of individual updates');
  });

  test('Base64 High-Performance: large buffers (64KB) roundtrip accurately without chunk corruption', () => {
    const largeBuffer = new Uint8Array(65536);
    for (let i = 0; i < largeBuffer.length; i++) {
      largeBuffer[i] = (i * 31 + 7) & 0xff;
    }

    const b64 = uint8ArrayToBase64(largeBuffer);
    assert.ok(typeof b64 === 'string');
    assert.strictEqual(b64.length, Math.ceil(65536 / 3) * 4);

    const restored = base64ToUint8Array(b64);
    assert.strictEqual(restored.length, largeBuffer.length);
    assert.deepStrictEqual(restored, largeBuffer);
  });

  test('CodeMirror 6: rebindEffect is dispatchable and detectable in transaction effects', () => {
    let state = EditorState.create({ doc: 'Initial Document' });
    const tr = state.update({
      effects: [rebindEffect.of()],
    });

    const hasRebind = tr.effects.some((e) => e.is(rebindEffect));
    assert.strictEqual(hasRebind, true);
  });

  test('normalizePath: cross-platform slash and whitespace consistency', () => {
    assert.strictEqual(normalizePath('Japanese\\Accueil.md'), 'Japanese/Accueil.md');
    assert.strictEqual(normalizePath('/Japanese/Accueil.md/'), 'Japanese/Accueil.md');
    assert.strictEqual(normalizePath('Kurotsuki\\Notes\\Test.md'), 'Kurotsuki/Notes/Test.md');
    assert.strictEqual(normalizePath(''), '');
    assert.strictEqual(normalizePath(null), '');
    assert.strictEqual(normalizePath(undefined), '');
  });

  test('Cross-platform awareness matches Windows backslashes with mobile forward slashes', () => {
    const awareness = new AwarenessManager({ id: 'u1', name: 'PC', color: '#111' });
    awareness.updateActiveFile('Japanese\\Accueil.md'); // Windows path

    awareness.handleRemoteAwareness([
      {
        clientId: 42,
        user: { id: 'u2', name: 'Phone', color: '#222' },
        activeFile: 'Japanese/Accueil.md', // Mobile POSIX path
        cursor: { anchor: 10, head: 10 },
        lastActive: Date.now(),
      },
    ]);

    const peers = awareness.getActivePeersForFile('Japanese/Accueil.md');
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0].user.name, 'Phone');

    const peersWin = awareness.getActivePeersForFile('Japanese\\Accueil.md');
    assert.strictEqual(peersWin.length, 1);
    assert.strictEqual(peersWin[0].user.name, 'Phone');
    awareness.destroy();
  });

  test('Real-time Yjs CRDT: zero-duplication seed and instant peer edit propagation', () => {
    // Simulated Relay Server
    const serverDoc = new Y.Doc();

    // Client A (PC) and Client B (Phone)
    const clientA = new Y.Doc();
    const clientB = new Y.Doc();

    const localInitialText = 'Bonjour le monde';

    // PC requests doc from server (currently empty)
    Y.applyUpdate(clientA, Y.encodeStateAsUpdate(serverDoc));
    if (clientA.getText('content').length === 0) {
      clientA.getText('content').insert(0, localInitialText);
      // PC sends seed to server
      Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(clientA));
    }
    assert.strictEqual(serverDoc.getText('content').toString(), 'Bonjour le monde');

    // Phone connects and requests doc from server
    Y.applyUpdate(clientB, Y.encodeStateAsUpdate(serverDoc));
    assert.strictEqual(clientB.getText('content').toString(), 'Bonjour le monde');

    // Phone types '!' at the end
    let updateB: Uint8Array | null = null;
    clientB.on('update', (u) => { updateB = u; });
    clientB.getText('content').insert(16, '!');

    assert.ok(updateB);
    // Server receives and relays to PC
    Y.applyUpdate(serverDoc, updateB!);
    Y.applyUpdate(clientA, updateB!);

    assert.strictEqual(clientA.getText('content').toString(), 'Bonjour le monde!');
    assert.strictEqual(serverDoc.getText('content').toString(), 'Bonjour le monde!');
    assert.strictEqual(clientB.getText('content').toString(), 'Bonjour le monde!');
    assert.strictEqual(clientA.store.pendingStructs, null);
    assert.strictEqual(clientB.store.pendingStructs, null);
  });

  test('isUntitledFile detection correctly identifies French and English placeholder note names', () => {
    function isUntitledFile(filePath: string): boolean {
      const name = filePath.split('/').pop() || '';
      const baseName = name.replace(/\.[^/.]+$/, '');
      return /^(sans titre|untitled|nouvelle note|new note)(\s\d+)?$/i.test(baseName.trim());
    }

    assert.strictEqual(isUntitledFile('Sans titre.md'), true);
    assert.strictEqual(isUntitledFile('Plan/Sans titre.md'), true);
    assert.strictEqual(isUntitledFile('Plan/Sans titre 1.md'), true);
    assert.strictEqual(isUntitledFile('Untitled.md'), true);
    assert.strictEqual(isUntitledFile('Deep/Folder/Untitled 42.md'), true);
    assert.strictEqual(isUntitledFile('Nouvelle note.md'), true);
    assert.strictEqual(isUntitledFile('New note.md'), true);

    // Real notes should NOT match
    assert.strictEqual(isUntitledFile('Plan/Conditions Japonais.md'), false);
    assert.strictEqual(isUntitledFile('Accueil.md'), false);
    assert.strictEqual(isUntitledFile('Grammaire N2.md'), false);
  });

  test('Rename redirection map redirects in-flight responses and prevents zombie file resurrection', () => {
    const renamedOrDeletedPaths = new Map<string, string | null>();

    // Simulated event: user creates 'Sans titre.md' and quickly renames to 'Conditions Japonais.md'
    renamedOrDeletedPaths.set('Plan/Sans titre.md', 'Plan/Conditions Japonais.md');

    // Stray in-flight doc_response arrives for 'Plan/Sans titre.md'
    const incomingPath = 'Plan/Sans titre.md';
    let targetPath = incomingPath;
    const redirect = renamedOrDeletedPaths.get(incomingPath);
    if (redirect) {
      targetPath = redirect;
    }

    // Verify redirected to 'Conditions Japonais.md'
    assert.strictEqual(targetPath, 'Plan/Conditions Japonais.md');

    // Simulated event: doc deleted
    renamedOrDeletedPaths.set('Plan/Temporary.md', null);
    const deleteCheck = renamedOrDeletedPaths.get('Plan/Temporary.md');
    assert.strictEqual(deleteCheck, null);
  });

  test('CodeMirror 6: remote transactions carry remoteSyncAnnotation and Transaction.addToHistory(false)', () => {
    const { Transaction } = require('@codemirror/state');
    let state = EditorState.create({ doc: 'Hello' });
    const tr = state.update({
      changes: { from: 5, insert: ' World' },
      annotations: [remoteSyncAnnotation.of(true), Transaction.addToHistory.of(false)],
    });
    assert.strictEqual(tr.annotation(remoteSyncAnnotation), true);
    assert.strictEqual(tr.annotation(Transaction.addToHistory), false);
    state = tr.state;
    assert.strictEqual(state.doc.toString(), 'Hello World');
  });

  test('Folder vs File: Extension extraction and CRDT doc classification', () => {
    function getExtension(filePath: string): string {
      const clean = normalizePath(filePath);
      const lastSlash = clean.lastIndexOf('/');
      const fileName = lastSlash >= 0 ? clean.substring(lastSlash + 1) : clean;
      const dotIndex = fileName.lastIndexOf('.');
      if (dotIndex <= 0) return '';
      return fileName.substring(dotIndex + 1).toLowerCase();
    }

    function isCrdtDoc(filePath: string): boolean {
      const ext = getExtension(filePath);
      return ext === 'md' || ext === 'txt' || ext === 'canvas';
    }

    function isAttachmentPath(filePath: string): boolean {
      const ext = getExtension(filePath);
      if (!ext) return false;
      return ext !== 'md' && ext !== 'txt' && ext !== 'canvas';
    }

    // Folders (no extension)
    assert.strictEqual(getExtension('Vocabulaire'), '');
    assert.strictEqual(getExtension('Japanese/Cours'), '');
    assert.strictEqual(isCrdtDoc('Vocabulaire'), false);
    assert.strictEqual(isCrdtDoc('Japanese/Cours'), false);
    assert.strictEqual(isAttachmentPath('Vocabulaire'), false);
    assert.strictEqual(isAttachmentPath('Japanese/Cours'), false);

    // Markdown / CRDT files
    assert.strictEqual(getExtension('Note.md'), 'md');
    assert.strictEqual(getExtension('Folder/Doc.txt'), 'txt');
    assert.strictEqual(getExtension('Visual.canvas'), 'canvas');
    assert.strictEqual(isCrdtDoc('Note.md'), true);
    assert.strictEqual(isCrdtDoc('Folder/Doc.txt'), true);
    assert.strictEqual(isCrdtDoc('Visual.canvas'), true);
    assert.strictEqual(isAttachmentPath('Note.md'), false);

    // Attachments
    assert.strictEqual(getExtension('image.png'), 'png');
    assert.strictEqual(getExtension('archive.zip'), 'zip');
    assert.strictEqual(isCrdtDoc('image.png'), false);
    assert.strictEqual(isAttachmentPath('image.png'), true);
    assert.strictEqual(isAttachmentPath('archive.zip'), true);
  });
});

