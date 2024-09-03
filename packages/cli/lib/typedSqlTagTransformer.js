var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import chokidar from 'chokidar';
import fs from 'fs-extra';
import { globSync } from 'glob';
import path from 'path';
import { generateDeclarations, genTypedSQLOverloadFunctions, } from './generator.js';
import { TypeAllocator } from './types.js';
import { debug } from './util.js';
function uniqBy(array, keyFn) {
    return array.reduce((acc, item) => {
        const key = keyFn(item);
        const isDuplicate = acc.some(existingItem => keyFn(existingItem) === key);
        if (!isDuplicate) {
            acc.push(item);
        }
        return acc;
    }, []);
}
// tslint:disable:no-console
export class TypedSqlTagTransformer {
    constructor(pool, config, transform) {
        this.pool = pool;
        this.config = config;
        this.transform = transform;
        this.workQueue = [];
        this.cache = {};
        this.contentStart = `import { ${this.transform.functionName} as sourceSql } from '@pgtyped/runtime';\n\n`;
        this.contentEnd = [
            `export function ${this.transform.functionName}(s: string): unknown;`,
            `export function ${this.transform.functionName}(s: string): unknown {`,
            `  return sourceSql([s] as any);`,
            `}`,
        ];
        this.includePattern = `${this.config.srcDir}/**/${transform.include}`;
        this.localFileName = this.transform.emitFileName;
        this.fullFileName = path.relative(process.cwd(), this.localFileName);
    }
    watch() {
        return __awaiter(this, void 0, void 0, function* () {
            let initialized = false;
            const cb = (fileName) => __awaiter(this, void 0, void 0, function* () {
                const job = {
                    files: [fileName],
                };
                !initialized
                    ? this.pushToQueue(job)
                    : yield this.generateTypedSQLTagFileForJob(job, true);
            });
            chokidar
                .watch(this.includePattern, {
                persistent: true,
                ignored: [this.localFileName],
            })
                .on('add', cb)
                .on('change', cb)
                .on('unlink', (file) => __awaiter(this, void 0, void 0, function* () { return yield this.removeFileFromCache(file); }))
                .on('ready', () => __awaiter(this, void 0, void 0, function* () {
                initialized = true;
                yield this.waitForTypedSQLQueueAndGenerate(true);
            }));
        });
    }
    start(watch) {
        return __awaiter(this, void 0, void 0, function* () {
            if (watch) {
                return this.watch();
            }
            const fileList = globSync(this.includePattern, {
                ignore: [this.localFileName],
            });
            debug('found query files %o', fileList);
            yield this.generateTypedSQLTagFileForJob({
                files: fileList,
            });
        });
    }
    pushToQueue(job) {
        this.workQueue.push(...job.files.map((fileName) => this.getTsTypeDecs(fileName)));
    }
    getTsTypeDecs(fileName) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`Processing ${fileName}`);
            return (yield this.pool.run({
                fileName,
                transform: this.transform,
            }, 'getTypeDecs'));
            // Result should be serializable!
        });
    }
    generateTypedSQLTagFileForJob(job, useCache) {
        return __awaiter(this, void 0, void 0, function* () {
            this.pushToQueue(job);
            return this.waitForTypedSQLQueueAndGenerate(useCache);
        });
    }
    waitForTypedSQLQueueAndGenerate(useCache) {
        return __awaiter(this, void 0, void 0, function* () {
            const queueResults = yield Promise.all(this.workQueue);
            this.workQueue.length = 0;
            const typeDecsSets = [];
            for (const result of queueResults) {
                if (result === null || result === void 0 ? void 0 : result.typedQueries.length) {
                    typeDecsSets.push(result);
                    if (useCache)
                        this.cache[result.fileName] = result;
                }
            }
            return this.generateTypedSQLTagFile(useCache ? Object.values(this.cache) : typeDecsSets);
        });
    }
    removeFileFromCache(fileToRemove) {
        return __awaiter(this, void 0, void 0, function* () {
            delete this.cache[fileToRemove];
            return this.generateTypedSQLTagFile(Object.values(this.cache));
        });
    }
    generateTypedSQLTagFile(typeDecsSets) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`Generating ${this.fullFileName}...`);
            const aliasTypeDefinitions = uniqBy(typeDecsSets.flatMap(it => it.typeDefinitions.aliases), it => it.name).map(it => TypeAllocator.typeDefinitionDeclarations(this.transform.emitFileName, { aliases: [it], imports: {}, enums: [] }));
            const enumTypeDefinitions = uniqBy(typeDecsSets.flatMap(it => it.typeDefinitions.enums), it => it.name).map(it => TypeAllocator.typeDefinitionDeclarations(this.transform.emitFileName, { aliases: [], imports: {}, enums: [it] }));
            const importTypeDefinitions = uniqBy(typeDecsSets.flatMap(it => Object.entries(it.typeDefinitions.imports).flatMap(([key, imports]) => imports)), it => it.name).map(it => TypeAllocator.typeDefinitionDeclarations(this.transform.emitFileName, { aliases: [], imports: { [it.name]: [it] }, enums: [] }));
            const normalizeQueryText = (text) => text.replace(/\s+/g, ' ').trim();
            const groupedTypedQueries = typeDecsSets.flatMap(it => it.typedQueries)
                .reduce((acc, query) => {
                const normalizedText = normalizeQueryText(query.query.ast.text);
                if (!acc[normalizedText]) {
                    acc[normalizedText] = {
                        types: query,
                        queries: []
                    };
                }
                acc[normalizedText].queries.push(query);
                return acc;
            }, {});
            const uniqTypedQueries = Object.values(groupedTypedQueries).map(group => group.types);
            const overloads = Object.values(groupedTypedQueries).flatMap(group => genTypedSQLOverloadFunctions(this.transform.functionName, group.queries));
            yield fs.outputFile(this.fullFileName, [
                this.contentStart,
                ...aliasTypeDefinitions,
                ...enumTypeDefinitions,
                ...importTypeDefinitions,
                generateDeclarations(uniqTypedQueries),
                overloads.join('\n'),
                '\n\n',
                ...this.contentEnd,
            ].join('\n'));
            console.log(`Saved ${this.fullFileName}`);
        });
    }
}
//# sourceMappingURL=typedSqlTagTransformer.js.map