import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

import * as glob from 'glob';
import { Plugin } from 'rollup';
import { TransformContext } from 'rollup/dist/typings/utils/transform';
import * as ts from 'typescript';

import { getCodeFrame } from './utils';

async function getCompilerOptions() {
  const readFile = util.promisify(fs.readFile);

  const result = ts.parseConfigFileTextToJson(
    'tsconfig.json', await readFile('tsconfig.json', 'utf-8')
  );

  if (result.error)
    throw [result.error];

  const parsed = ts.parseJsonConfigFileContent(result.config, ts.sys, '');

  if (parsed.errors.length)
    throw parsed.errors;

  const compilerOptions = parsed.options;

  compilerOptions.importHelpers = true;
  compilerOptions.sourceMap = true;
  compilerOptions.module = ts.ModuleKind.ES2015;
  compilerOptions.moduleResolution = ts.ModuleResolutionKind.NodeJs;

  return compilerOptions;
}

function printDiagnostics(diagnostics: ts.Diagnostic[], context?: TransformContext) {
  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText, ts.sys.newLine
    );

    const file = diagnostic.file;
    const id = file ? file.fileName : null;
    const lc = file && diagnostic.start ?
      file.getLineAndCharacterOfPosition(diagnostic.start) : null;
    const loc = id && lc ? {
      file: id, line: lc.line + 1, column: lc.character
    } : undefined;

    if (context) {
      if (diagnostic.category == ts.DiagnosticCategory.Error)
        context.error({ message }, loc);
      else if (diagnostic.category == ts.DiagnosticCategory.Warning)
        context.warn({ message }, loc);
    } else {
      const frame = file && loc ?
        getCodeFrame(file.text, loc.line, loc.column) : null;
      throw { message, id, loc, frame };
    }
  }
}

export default function typescript() {
  let input: string[];
  let compilerOptions: ts.CompilerOptions;
  let program: ts.Program;

  const plugin: Plugin = {
    name: 'typescript',

    options(options) {
      input = Array.isArray(options.input) ? options.input : [options.input];
    },

    async resolveId(importee, importer) {
      if (path.extname(importee) || !importer.endsWith('.ts'))
        return;

      const filename = `${importee}.ts`;
      const id = path.resolve(path.dirname(importer), filename);
      const exists = await util.promisify(fs.exists)(id);

      if (!exists)
        return;

      return id;
    },

    async transform(source, id) {
      if (!id.endsWith('.ts'))
        return;

      if (!compilerOptions) {
        try {
          compilerOptions = await getCompilerOptions();
        } catch (diagnostics) {
          printDiagnostics(diagnostics);
        }
      }

      if (!program) {
        const files = await util.promisify(glob)(
          '**/*.d.ts', { ignore: 'node_modules/**' }
        );
        files.push(...input);
        program = ts.createProgram(files, compilerOptions);
      }

      const sourceFile = program.getSourceFile(id as string);
      if (sourceFile)
        printDiagnostics(ts.getPreEmitDiagnostics(program, sourceFile), this);

      const output = ts.transpileModule(source, { compilerOptions });

      return {
        code: output.outputText,
        map: output.sourceMapText ? JSON.parse(output.sourceMapText) : null
      };
    }
  };

  return plugin;
}
