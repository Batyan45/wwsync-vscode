const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const path = require('node:path');
const Module = require('node:module');

// Exercise the command handlers without starting VS Code, SSH or touching ~/.wwsync.
class EventEmitter {
    listeners = new Set();
    event = listener => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
}

class Uri {
    static from(parts) { return Object.assign(new Uri(), parts); }
    toString() { return `${this.scheme}://${this.authority.toLowerCase()}${this.path}`; }
}

const local = path.resolve('test-workspaces', 'Project');
const otherLocal = path.resolve('test-workspaces', 'Other');
const remote = '/home/test/llm/project';
const mapping = (local, remote) => ({ local, remote, excludes: [] });
const commands = new Map();
const visibility = new EventEmitter();
const fileChanges = new EventEmitter();
const editorChanges = new EventEmitter();
let config, folders, tree, explorer, session, homeCalls, directoryCalls, errors;
const vscode = {
    EventEmitter, Uri,
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    window: {
        createTreeView: () => (tree = {
            visible: true, selection: [], dispose() {},
            onDidChangeVisibility: visibility.event
        }),
        onDidChangeActiveTextEditor: editorChanges.event,
        withProgress: (_options, task) => task(),
        showErrorMessage: async message => { errors.push(message); },
        showInformationMessage: async () => undefined,
        showInputBox: async () => undefined,
        showQuickPick: async () => undefined
    },
    workspace: {
        get workspaceFolders() { return folders; },
        getConfiguration: () => ({ get: (_key, fallback) => fallback })
    },
    commands: {
        registerCommand: (id, fn) => {
            commands.set(id, fn);
            return { dispose: () => commands.delete(id) };
        },
        executeCommand: async () => undefined
    }
};
const originalLoad = Module._load;
let RemoteExplorer, SessionState, findMappingForPath, findServersForPath;
try {
    Module._load = function (name, ...args) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    const configuration = require('../out/config');
    configuration.loadConfig = () => config;
    configuration.saveConfig = () => { throw new Error('Tests must not write configuration'); };
    ({ RemoteExplorer } = require('../out/remoteExplorer'));
    ({ SessionState } = require('../out/sessionState'));
    ({ findMappingForPath, findServersForPath } = require('../out/serverSelector'));
} finally {
    Module._load = originalLoad;
}

const run = name => commands.get(`wwsync.remoteExplorer.${name}`)();
const workspace = local => [{ name: path.basename(local), uri: { scheme: 'file', fsPath: local } }];

beforeEach(() => {
    config = { servers: {
        alpha: { host: 'alpha', mappings: [mapping(local, remote)] },
        beta: { host: 'beta', mappings: [mapping(otherLocal, '/srv/other')] }
    } };
    folders = workspace(local);
    homeCalls = [];
    directoryCalls = [];
    errors = [];
    session = new SessionState();
    session.set(local, 'alpha');
    session.set(otherLocal, 'beta');
    explorer = new RemoteExplorer({
        onDidChangeFile: fileChanges.event,
        readDirectory: async uri => {
            directoryCalls.push(uri.path);
            return [['train.py', vscode.FileType.File]];
        }
    }, {
        getHome: async alias => { homeCalls.push(alias); return '/home/test'; },
        log() {}, disconnect() {}
    }, session);
});

afterEach(() => explorer.dispose());

test('showing an unconnected panel does not open an SSH session', async () => {
    visibility.fire({ visible: true });
    assert.deepEqual(await explorer.getChildren(), []);
    assert.deepEqual(homeCalls, []);
});

test('Open reads the configured project directory, not the SFTP home', async () => {
    await run('open');
    const children = await explorer.getChildren();
    assert.equal(tree.description, `alpha: ${remote}`);
    assert.deepEqual(directoryCalls, [remote]);
    assert.equal(children[0].uri.path, `${remote}/train.py`);
});

test('Open returns to the project after navigating up to the home directory', async () => {
    await run('open');
    await run('goUp');
    await run('goUp');
    assert.equal(tree.description, 'alpha: /home/test');
    await run('open');
    await explorer.getChildren();
    assert.equal(tree.description, `alpha: ${remote}`);
    assert.equal(directoryCalls.at(-1), remote);
});

test('Open follows the current workspace instead of keeping the previous project', async () => {
    await run('open');
    folders = workspace(otherLocal);
    await run('open');
    assert.equal(tree.description, 'beta: /srv/other');
    assert.deepEqual(homeCalls, ['alpha', 'beta']);
});

test('Open uses an updated mapping even when the panel is already connected', async () => {
    await run('open');
    config.servers.alpha.mappings[0].remote = '/srv/moved-project';
    await run('open');
    assert.equal(tree.description, 'alpha: /srv/moved-project');
});

test('a tilde mapping expands to the project inside the remote home', async () => {
    config.servers.alpha.mappings[0].remote = '~/llm/project';
    await run('open');
    assert.equal(tree.description, `alpha: ${remote}`);
});

test('a missing mapping never silently opens the remote home', async () => {
    config.servers.alpha.mappings = [];
    await run('open');
    assert.deepEqual(homeCalls, []);
    assert.equal(tree.description, undefined);
});

test('mapping selection respects the local platform case rules', () => {
    const differentCase = path.join(path.dirname(local), 'project');
    const lowerMapping = mapping(differentCase, '/srv/lowercase');
    config.servers.alpha.mappings.push(lowerMapping);
    assert.equal(findMappingForPath(config.servers.alpha, differentCase),
        process.platform === 'win32' ? config.servers.alpha.mappings[0] : lowerMapping);
    config.servers.beta.mappings = [lowerMapping];
    assert.deepEqual(findServersForPath(config, local), process.platform === 'win32' ? ['alpha', 'beta'] : ['alpha']);
});

test('Compare with Local prefers the correct case-sensitive project mapping', async () => {
    const differentCase = path.join(path.dirname(local), 'project');
    config.servers.alpha.mappings.push(mapping(differentCase, remote));
    await run('open');
    const expected = process.platform === 'win32' ? differentCase : local;
    assert.equal(await explorer.findLocalPath('alpha', `${remote}/train.py`), path.join(expected, 'train.py'));
});
