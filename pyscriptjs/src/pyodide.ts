import { Runtime } from './runtime';
import { getLogger } from './logger';
import { FetchError } from './exceptions'
import type { loadPyodide as loadPyodideDeclaration, PyodideInterface, PyProxy } from 'pyodide';
// eslint-disable-next-line
// @ts-ignore
import pyscript from './python/pyscript.py';
import { version } from './runtime';
import type { AppConfig } from './pyconfig';
import type { Stdio } from './stdio';

declare const loadPyodide: typeof loadPyodideDeclaration;

const logger = getLogger('pyscript/pyodide');

interface Micropip {
    install: (packageName: string | string[]) => Promise<void>;
    destroy: () => void;
}

export class PyodideRuntime extends Runtime {
    src: string;
    stdio: Stdio;
    name?: string;
    lang?: string;
    interpreter: PyodideInterface;
    globals: PyProxy;

    constructor(
        config: AppConfig,
        stdio: Stdio,
        src = 'https://cdn.jsdelivr.net/pyodide/v0.21.3/full/pyodide.js',
        name = 'pyodide-default',
        lang = 'python',
    ) {
        logger.info('Runtime config:', { name, lang, src });
        super(config);
        this.stdio = stdio;
        this.src = src;
        this.name = name;
        this.lang = lang;
    }

    /**
     * Although `loadPyodide` is used below,
     * notice that it is not imported i.e.
     * import { loadPyodide } from 'pyodide';
     * is not used at the top of this file.
     *
     * This is because, if it's used, loadPyodide
     * behaves mischievously i.e. it tries to load
     * `pyodide.asm.js` and `pyodide_py.tar` but
     * with paths that are wrong such as:
     *
     * http://127.0.0.1:8080/build/pyodide_py.tar
     * which results in a 404 since `build` doesn't
     * contain these files and is clearly the wrong
     * path.
     */
    async loadInterpreter(): Promise<void> {
        logger.info('Loading pyodide');
        this.interpreter = await loadPyodide({
            stdout: (msg: string) => { this.stdio.stdout_writeline(msg); },
            stderr: (msg: string) => { this.stdio.stderr_writeline(msg); },
            fullStdLib: false,
        });

        this.globals = this.interpreter.globals;

        // XXX: ideally, we should load micropip only if we actually need it
        await this.loadPackage('micropip');

        logger.info('importing pyscript.py');
        this.run(pyscript as string);
        this.run(`PyScript.set_version_info('${version}')`)

        logger.info('pyodide loaded and initialized');
    }

    run(code: string): unknown {
        return this.interpreter.runPython(code);
    }

    registerJsModule(name: string, module: object): void {
        this.interpreter.registerJsModule(name, module);
    }

    async loadPackage(names: string | string[]): Promise<void> {
        logger.info(`pyodide.loadPackage: ${names.toString()}`);
        await this.interpreter.loadPackage(names, logger.info.bind(logger), logger.info.bind(logger));
    }

    async installPackage(package_name: string | string[]): Promise<void> {
        if (package_name.length > 0) {
            logger.info(`micropip install ${package_name.toString()}`);
            const micropip = this.globals.get('micropip') as Micropip;
            await micropip.install(package_name);
            micropip.destroy();
        }
    }

    async loadFromFile(path: string, fetch_path: string): Promise<void> {
        const pathArr = path.split('/');
        const filename = pathArr.pop();
        for (let i = 0; i < pathArr.length; i++) {
            const eachPath = pathArr.slice(0, i + 1).join('/');
            const { exists, parentExists } = this.interpreter.FS.analyzePath(eachPath);
            if (!parentExists) {
                throw new Error(`'INTERNAL ERROR! cannot create ${path}, this should never happen'`);
            }
            if (!exists) {
                this.interpreter.FS.mkdir(eachPath);
            }
        }
        const response = await fetch(fetch_path);
        if (response.status !== 200) {
            throw new FetchError(`Unable to fetch  ${fetch_path}, reason: ${response.status} - ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        const data = new Uint8Array(buffer);
        pathArr.push(filename);
        const stream = this.interpreter.FS.open(pathArr.join('/'), 'w');
        this.interpreter.FS.write(stream, data, 0, data.length, 0);
        this.interpreter.FS.close(stream);
    }
}
