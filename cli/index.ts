import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";
import yargs from "yargs";

import * as chokidar from "chokidar";
import { build, compile, credentials, init, install, run, test } from "df/cli/api";
import { CREDENTIALS_FILENAME } from "df/cli/api/commands/credentials";
import { BigQueryDbAdapter } from "df/cli/api/dbadapters/bigquery";
import { prettyJsonStringify } from "df/cli/api/utils";
import {
  print,
  printCompiledGraph,
  printCompiledGraphErrors,
  printError,
  printExecutedAction,
  printExecutionGraph,
  printFormatFilesResult,
  printInitCredsResult,
  printInitResult,
  printSuccess,
  printTestResult
} from "df/cli/console";
import { getBigQueryCredentials } from "df/cli/credentials";
import { actuallyResolve, assertPathExists, compiledGraphHasErrors } from "df/cli/util";
import { createYargsCli, INamedOption } from "df/cli/yargswrapper";
import { targetAsReadableString } from "df/core/targets";
import { dataform } from "df/protos/ts";
import { formatFile } from "df/sqlx/format";
import parseDuration from "parse-duration";

const RECOMPILE_DELAY = 500;

process.on("unhandledRejection", async (reason: any) => {
  printError(`Unhandled promise rejection: ${reason?.stack || reason}`);
});

// TODO: Since yargs launched an actually well typed API in version 12, let's use it as this file is currently not type checked.

const projectDirOption: INamedOption<yargs.PositionalOptions> = {
  name: "project-dir",
  option: {
    describe: "The Dataform project directory.",
    default: ".",
    coerce: actuallyResolve
  }
};

const projectDirMustExistOption = {
  ...projectDirOption,
  check: (argv: yargs.Arguments<any>) => {
    assertPathExists(argv[projectDirOption.name]);
    const dataformJsonPath = path.resolve(argv[projectDirOption.name], "dataform.json");
    const workflowSettingsYamlPath = path.resolve(
      argv[projectDirOption.name],
      "workflow_settings.yaml"
    );
    if (!fs.existsSync(dataformJsonPath) && !fs.existsSync(workflowSettingsYamlPath)) {
      throw new Error(
        `${
          argv[projectDirOption.name]
        } does not appear to be a dataform directory (missing workflow_settings.yaml file).`
      );
    }
  }
};

const fullRefreshOption: INamedOption<yargs.Options> = {
  name: "full-refresh",
  option: {
    describe: "Forces incremental tables to be rebuilt from scratch.",
    type: "boolean",
    default: false
  }
};

const actionsOption: INamedOption<yargs.Options> = {
  name: "actions",
  option: {
    describe: "A list of action names or patterns to run. Can include '*' wildcards.",
    type: "array",
    coerce: (rawActions: string[] | null) => rawActions.map(actions => actions.split(",")).flat()
  }
};

const tagsOption: INamedOption<yargs.Options> = {
  name: "tags",
  option: {
    describe: "A list of tags to filter the actions to run.",
    type: "array",
    coerce: (rawTags: string[] | null) => rawTags.map(tags => tags.split(",")).flat()
  }
};

const includeDepsOption: INamedOption<yargs.Options> = {
  name: "include-deps",
  option: {
    describe: "If set, dependencies for selected actions will also be run.",
    type: "boolean"
  },
  // It would be nice to use yargs' "implies" to implement this, but it doesn't work for some reason.
  check: (argv: yargs.Arguments) => {
    if (argv[includeDepsOption.name] && !(argv[actionsOption.name] || argv[tagsOption.name])) {
      throw new Error(
        `The --${includeDepsOption.name} flag should only be supplied along with --${actionsOption.name} or --${tagsOption.name}.`
      );
    }
  }
};

const includeDependentsOption: INamedOption<yargs.Options> = {
  name: "include-dependents",
  option: {
    describe: "If set, dependents (downstream) for selected actions will also be run.",
    type: "boolean"
  },
  // It would be nice to use yargs' "implies" to implement this, but it doesn't work for some reason.
  check: (argv: yargs.Arguments) => {
    if (
      argv[includeDependentsOption.name] &&
      !(argv[actionsOption.name] || argv[tagsOption.name])
    ) {
      throw new Error(
        `The --${includeDependentsOption.name} flag should only be supplied along with --${actionsOption.name} or --${tagsOption.name}.`
      );
    }
  }
};

const credentialsOption: INamedOption<yargs.Options> = {
  name: "credentials",
  option: {
    describe: "The location of the credentials JSON file to use.",
    default: CREDENTIALS_FILENAME
  },
  check: (argv: yargs.Arguments<any>) =>
    getCredentialsPath(argv[projectDirOption.name], argv[credentialsOption.name])
};

const jsonOutputOption: INamedOption<yargs.Options> = {
  name: "json",
  option: {
    describe: "Outputs a JSON representation of the compiled project.",
    type: "boolean",
    default: false
  }
};

const timeoutOption: INamedOption<yargs.Options> = {
  name: "timeout",
  option: {
    describe: "Duration to allow project compilation to complete. Examples: '1s', '10m', etc.",
    type: "string",
    default: null,
    coerce: (rawTimeoutString: string | null) =>
      rawTimeoutString ? parseDuration(rawTimeoutString) : null
  }
};

const jobPrefixOption: INamedOption<yargs.Options> = {
  name: "job-prefix",
  option: {
    describe: "Adds an additional prefix in the form of `dataform-${jobPrefix}-`.",
    type: "string",
    default: null
  }
};

const testConnectionOptionName = "test-connection";

const watchOptionName = "watch";

const dryRunOptionName = "dry-run";
const runTestsOptionName = "run-tests";
const checkOptionName = "check";

const actionRetryLimitName = "action-retry-limit";

function getCredentialsPath(projectDir: string, credentialsPath: string) {
  return actuallyResolve(projectDir, credentialsPath);
}

export function runCli() {
  const builtYargs = createYargsCli({
    commands: [
      {
        // This dummy command is a hack with the only goal of displaying "help" as a command in the CLI
        // and we need it because of the limitations of yargs considering "help" as an option and not as a command.
        format: "help [command]",
        description: "Show help. If [command] is specified, the help is for the given command.",
        positionalOptions: [],
        options: [],
        processFn: async argv => {
          return 0;
        }
      },
      {
        format:
          `init [${projectDirOption.name}] [${ProjectConfigOptions.defaultDatabase.name}]` +
          ` [${ProjectConfigOptions.defaultLocation.name}]`,
        description: "Create a new dataform project.",
        positionalOptions: [
          projectDirOption,
          {
            name: ProjectConfigOptions.defaultDatabase.name,
            option: {
              describe: "The default database to use, equivalent to Google Cloud Project ID."
            },
            check: (argv: yargs.Arguments<any>) => {
              if (!argv[ProjectConfigOptions.defaultDatabase.name]) {
                throw new Error(
                  `The ${ProjectConfigOptions.defaultDatabase.name} positional argument is ` +
                    `required. Use "dataform help init" for more info.`
                );
              }
            }
          },
          {
            name: ProjectConfigOptions.defaultLocation.name,
            option: {
              describe:
                "The default location to use. See " +
                "https://cloud.google.com/bigquery/docs/locations for supported values."
            },
            check: (argv: yargs.Arguments<any>) => {
              if (!argv[ProjectConfigOptions.defaultLocation.name]) {
                throw new Error(
                  `The ${ProjectConfigOptions.defaultLocation.name} positional argument is ` +
                    `required. Use "dataform help init" for more info.`
                );
              }
            }
          }
        ],
        options: [],
        processFn: async argv => {
          print("Writing project files...\n");
          const initResult = await init(argv[projectDirOption.name], {
            defaultDatabase: argv[ProjectConfigOptions.defaultDatabase.name],
            defaultLocation: argv[ProjectConfigOptions.defaultLocation.name]
          });
          printInitResult(initResult);
          return 0;
        }
      },
      {
        format: `install [${projectDirMustExistOption.name}]`,
        description: "Install a project's NPM dependencies.",
        positionalOptions: [projectDirMustExistOption],
        options: [],
        processFn: async argv => {
          print("Installing NPM dependencies...\n");
          await install(argv[projectDirMustExistOption.name]);
          printSuccess("Project dependencies successfully installed.");
          return 0;
        }
      },
      {
        format: `init-creds [${projectDirMustExistOption.name}]`,
        description:
          `Create a ${credentials.CREDENTIALS_FILENAME} file for Dataform to use when ` +
          `accessing BigQuery.`,
        positionalOptions: [projectDirMustExistOption],
        options: [
          {
            name: testConnectionOptionName,
            option: {
              describe: "If true, a test query will be run using your final credentials.",
              type: "boolean",
              default: true
            }
          }
        ],
        processFn: async argv => {
          const finalCredentials = getBigQueryCredentials();
          if (argv[testConnectionOptionName]) {
            print("\nRunning connection test...");
            const dbadapter = new BigQueryDbAdapter(finalCredentials);
            const testResult = await credentials.test(dbadapter);
            switch (testResult.status) {
              case credentials.TestResultStatus.SUCCESSFUL: {
                printSuccess("\nCredentials test query completed successfully.\n");
                break;
              }
              case credentials.TestResultStatus.TIMED_OUT: {
                throw new Error("Credentials test connection timed out.");
              }
              case credentials.TestResultStatus.OTHER_ERROR: {
                throw new Error(
                  `Credentials test query failed: ${testResult.error.stack ||
                    testResult.error.message}`
                );
              }
            }
          } else {
            print("\nCredentials test query was not run.\n");
          }
          const filePath = path.resolve(
            argv[projectDirMustExistOption.name],
            credentials.CREDENTIALS_FILENAME
          );
          fs.writeFileSync(filePath, prettyJsonStringify(finalCredentials));
          printInitCredsResult(filePath);
          return 0;
        }
      },
      {
        format: `compile [${projectDirMustExistOption.name}]`,
        description:
          "Compile the dataform project. Produces JSON output describing the non-executable graph.",
        positionalOptions: [projectDirMustExistOption],
        options: [
          {
            name: watchOptionName,
            option: {
              describe: "Whether to watch the changes in the project directory.",
              type: "boolean",
              default: false
            }
          },
          jsonOutputOption,
          timeoutOption,
          ...ProjectConfigOptions.allYargsOptions
        ],
        processFn: async argv => {
          const projectDir = argv[projectDirMustExistOption.name];

          async function compileAndPrint() {
            if (!argv[jsonOutputOption.name]) {
              print("Compiling...\n");
            }
            const compiledGraph = await compile({
              projectDir,
              projectConfigOverride: ProjectConfigOptions.constructProjectConfigOverride(argv),
              timeoutMillis: argv[timeoutOption.name] || undefined
            });
            printCompiledGraph(compiledGraph, argv[jsonOutputOption.name]);
            if (compiledGraphHasErrors(compiledGraph)) {
              print("");
              printCompiledGraphErrors(compiledGraph.graphErrors);
              return true;
            }
            return false;
          }

          const graphHasErrors = await compileAndPrint();

          if (!argv[watchOptionName]) {
            return graphHasErrors ? 1 : 0;
          }

          let watching = true;

          let timeoutID: NodeJS.Timer = null;
          let isCompiling = false;

          // Initialize watcher.
          const watcher = chokidar.watch(projectDir, {
            ignored: /node_modules/,
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
              stabilityThreshold: 1000,
              pollInterval: 200
            }
          });

          const printReady = () => {
            print("\nWatching for changes...\n");
          };
          // Add event listeners.
          watcher
            .on("ready", printReady)
            .on("error", error => {
              // This error is caught not if there is a compilation error, but
              // if the watcher fails; this indicates an failure on our side.
              printError(`Error: ${error}`);
              process.exit(1);
            })
            .on("all", () => {
              if (timeoutID || isCompiling) {
                // don't recompile many times if we changed a lot of files
                clearTimeout(timeoutID);
              }

              timeoutID = setTimeout(async () => {
                clearTimeout(timeoutID);

                if (!isCompiling) {
                  isCompiling = true;
                  await compileAndPrint();
                  printReady();
                  isCompiling = false;
                }
              }, RECOMPILE_DELAY);
            });
          process.on("SIGINT", async () => {
            await watcher.close();
            watching = false;
            process.exit(1);
          });
          while (watching) {
            await new Promise((resolve, reject) => setTimeout(() => resolve(), 100));
          }
        }
      },
      {
        format: `test [${projectDirMustExistOption.name}]`,
        description: "Run the dataform project's unit tests.",
        positionalOptions: [projectDirMustExistOption],
        options: [credentialsOption, timeoutOption, ...ProjectConfigOptions.allYargsOptions],
        processFn: async argv => {
          print("Compiling...\n");
          const compiledGraph = await compile({
            projectDir: argv[projectDirMustExistOption.name],
            projectConfigOverride: ProjectConfigOptions.constructProjectConfigOverride(argv),
            timeoutMillis: argv[timeoutOption.name] || undefined
          });
          if (compiledGraphHasErrors(compiledGraph)) {
            printCompiledGraphErrors(compiledGraph.graphErrors);
            return 1;
          }
          printSuccess("Compiled successfully.\n");
          const readCredentials = credentials.read(
            getCredentialsPath(argv[projectDirOption.name], argv[credentialsOption.name])
          );

          if (!compiledGraph.tests.length) {
            printError("No unit tests found.");
            return 1;
          }

          print(`Running ${compiledGraph.tests.length} unit tests...\n`);
          const dbadapter = new BigQueryDbAdapter(readCredentials);
          const testResults = await test(dbadapter, compiledGraph.tests);
          testResults.forEach(testResult => printTestResult(testResult));
          return testResults.every(testResult => testResult.successful) ? 0 : 1;
        }
      },
      {
        format: `run [${projectDirMustExistOption.name}]`,
        description: "Run the dataform project.",
        positionalOptions: [projectDirMustExistOption],
        options: [
          {
            name: dryRunOptionName,
            option: {
              describe:
                "If set, BigQuery will validate the run SQL without applying changes to the warehouse.",
              type: "boolean"
            }
          },
          {
            name: runTestsOptionName,
            option: {
              describe:
                "If set, the project's unit tests are required to pass before running the project.",
              type: "boolean"
            }
          },
          {
            name: actionRetryLimitName,
            option: {
              describe: "If set, idempotent actions will be retried up to the limit.",
              type: "number",
              default: 0
            }
          },
          actionsOption,
          credentialsOption,
          fullRefreshOption,
          includeDepsOption,
          includeDependentsOption,
          credentialsOption,
          jsonOutputOption,
          timeoutOption,
          tagsOption,
          ...ProjectConfigOptions.allYargsOptions
        ],
        processFn: async argv => {
          if (argv[jsonOutputOption.name] && !argv[dryRunOptionName]) {
            print(
              `For execution, the --${jsonOutputOption.name} option is only supported if the ` +
                `--${dryRunOptionName} option is enabled`
            );
            return;
          }
          if (!argv[jsonOutputOption.name]) {
            print("Compiling...\n");
          }
          const compiledGraph = await compile({
            projectDir: argv[projectDirOption.name],
            projectConfigOverride: ProjectConfigOptions.constructProjectConfigOverride(argv),
            timeoutMillis: argv[timeoutOption.name] || undefined
          });
          if (compiledGraphHasErrors(compiledGraph)) {
            printCompiledGraphErrors(compiledGraph.graphErrors);
            return 1;
          }
          if (!argv[jsonOutputOption.name]) {
            printSuccess("Compiled successfully.\n");
          }
          const readCredentials = credentials.read(
            getCredentialsPath(argv[projectDirOption.name], argv[credentialsOption.name])
          );

          const dbadapter = new BigQueryDbAdapter(readCredentials);
          const executionGraph = await build(
            compiledGraph,
            {
              fullRefresh: argv[fullRefreshOption.name],
              actions: argv[actionsOption.name],
              includeDependencies: argv[includeDepsOption.name],
              includeDependents: argv[includeDependentsOption.name],
              tags: argv[tagsOption.name]
            },
            dbadapter
          );

          if (argv[dryRunOptionName] && argv[jsonOutputOption.name]) {
            printExecutionGraph(executionGraph, argv[jsonOutputOption.name]);
            return;
          }

          if (argv[runTestsOptionName]) {
            print(`Running ${compiledGraph.tests.length} unit tests...\n`);
            const testResults = await test(dbadapter, compiledGraph.tests);
            testResults.forEach(testResult => printTestResult(testResult));
            if (testResults.some(testResult => !testResult.successful)) {
              printError("\nUnit tests did not pass; aborting run.");
              return 1;
            }
            printSuccess("Unit tests completed successfully.\n");
          }

          let bigqueryOptions: {} = {
            actionRetryLimit: argv[actionRetryLimitName]
          };
          if (argv[dryRunOptionName]) {
            bigqueryOptions = { ...bigqueryOptions, dryRun: argv[dryRunOptionName] };
          }
          if (argv[jobPrefixOption.name]) {
            bigqueryOptions = { ...bigqueryOptions, jobPrefix: argv[jobPrefixOption.name] };
          }

          const actionsByName = new Map<string, dataform.IExecutionAction>();
          executionGraph.actions.forEach(action => {
            actionsByName.set(targetAsReadableString(action.target), action);
          });

          if (actionsByName.size === 0) {
            print("No actions to run.\n");
            return 0;
          }

          if (argv[dryRunOptionName]) {
            print("Dry running (no changes to the warehouse will be applied)...");
          } else {
            print("Running...\n");
          }

          const runner = run(dbadapter, executionGraph, { bigquery: bigqueryOptions });
          process.on("SIGINT", () => {
            runner.cancel();
          });

          const alreadyPrintedActions = new Set<string>();

          const printExecutedGraph = (executedGraph: dataform.IRunResult) => {
            executedGraph.actions
              .filter(
                actionResult =>
                  actionResult.status !== dataform.ActionResult.ExecutionStatus.RUNNING
              )
              .filter(
                executedAction =>
                  !alreadyPrintedActions.has(targetAsReadableString(executedAction.target))
              )
              .forEach(executedAction => {
                printExecutedAction(
                  executedAction,
                  actionsByName.get(targetAsReadableString(executedAction.target)),
                  argv[dryRunOptionName]
                );
                alreadyPrintedActions.add(targetAsReadableString(executedAction.target));
              });
          };

          runner.onChange(printExecutedGraph);
          const runResult = await runner.result();
          printExecutedGraph(runResult);
          return runResult.status === dataform.RunResult.ExecutionStatus.SUCCESSFUL ? 0 : 1;
        }
      },
      {
        format: `format [${projectDirMustExistOption.name}]`,
        description: "Format the dataform project's files.",
        positionalOptions: [projectDirMustExistOption],
        options: [
          actionsOption,
          {
            name: checkOptionName,
            option: {
              describe: "Check if files are formatted correctly without modifying them.",
              type: "boolean",
              default: false
            }
          }
        ],
        processFn: async argv => {
          let actions = ["{definitions,includes}/**/*.{js,sqlx}"];
          if (actionsOption.name in argv && argv[actionsOption.name].length > 0) {
            actions = argv[actionsOption.name];
          }
          const filenames = actions
            .map((action: string) =>
              glob.sync(action, { cwd: argv[projectDirMustExistOption.name] })
            )
            .flat();

          const isCheckMode = argv[checkOptionName];
          const results: Array<{
            filename: string;
            err?: Error;
            needsFormatting?: boolean;
          }> = await Promise.all(
            filenames.map(async (filename: string) => {
              try {
                const filePath = path.resolve(argv[projectDirMustExistOption.name], filename);
                if (isCheckMode) {
                  // In check mode, we don't modify files, just check if they need formatting
                  const fileContent = fs.readFileSync(filePath).toString();
                  const formattedContent = await formatFile(filePath, {
                    overwriteFile: false
                  });
                  return {
                    filename,
                    needsFormatting: fileContent !== formattedContent
                  };
                } else {
                  // Normal formatting mode
                  await formatFile(filePath, {
                    overwriteFile: true
                  });
                  return {
                    filename
                  };
                }
              } catch (e) {
                return {
                  filename,
                  err: e
                };
              }
            })
          );

          printFormatFilesResult(results);

          // Return error code if there are any formatting errors
          const failedFormatResults = results.filter(result => !!result.err);
          if (failedFormatResults.length > 0) {
            printError(`${failedFormatResults.length} file(s) failed to format.`);
            return 1;
          }

          // In check mode, return an error code if any files need formatting
          if (isCheckMode) {
            const filesNeedingFormatting = results.filter(result => result.needsFormatting);
            if (filesNeedingFormatting.length > 0) {
              printError(
                `${filesNeedingFormatting.length} file(s) would be reformatted. Run the format command without --check to update.`
              );
              return 1;
            }
            printSuccess("All files are formatted correctly!");
          }

          return 0;
        }
      }
    ]
  })
    .scriptName("dataform")
    .strict()
    .wrap(null)
    .recommendCommands()
    .fail(async (msg: string, err: any) => {
      if (!!err && err.name === "VMError" && err.message.includes("Cannot find module")) {
        printError("Could not find NPM dependencies. Have you run 'dataform install'?");
      } else {
        const message = err?.message ? err.message.split("\n")[0] : msg;
        printError(`Dataform encountered an error: ${message}`);
        if (err?.stack) {
          printError(err.stack);
        }
      }
      process.exit(1);
    }).argv;

  // If no command is specified, show top-level help string.
  if (!builtYargs._[0]) {
    yargs.showHelp();
  }
}

class ProjectConfigOptions {
  public static defaultDatabase: INamedOption<yargs.Options> = {
    name: "default-database",
    option: {
      describe:
        "The default database to use, equivalent to Google Cloud Project ID. If unset, " +
        "the value from workflow_settings.yaml is used.",
      type: "string"
    }
  };

  public static defaultSchema: INamedOption<yargs.Options> = {
    name: "default-schema",
    option: {
      describe:
        "Override for the default schema name. If unset, the value from workflow_settings.yaml is used."
    }
  };

  public static defaultLocation: INamedOption<yargs.Options> = {
    name: "default-location",
    option: {
      describe:
        "The default location to use. See " +
        "https://cloud.google.com/bigquery/docs/locations for supported values. If unset, the " +
        "value from workflow_settings.yaml is used."
    }
  };

  public static assertionSchema: INamedOption<yargs.Options> = {
    name: "assertion-schema",
    option: {
      describe: "Default assertion schema. If unset, the value from workflow_settings.yaml is used."
    }
  };

  public static databaseSuffix: INamedOption<yargs.Options> = {
    name: "database-suffix",
    option: {
      describe: "Default assertion schema. If unset, the value from workflow_settings.yaml is used."
    }
  };

  public static vars: INamedOption<yargs.Options> = {
    name: "vars",
    option: {
      describe:
        "Override for variables to inject via '--vars=someKey=someValue,a=b', referenced by " +
        "`dataform.projectConfig.vars.someValue`.  If unset, the value from workflow_settings.yaml is used.",
      type: "string",
      default: null,
      coerce: (rawVarsString: string | null) => {
        const variables: { [key: string]: string } = {};
        rawVarsString?.split(",").forEach(keyValueStr => {
          const [key, value] = keyValueStr.split("=");
          variables[key] = value;
        });
        return variables;
      }
    }
  };

  public static schemaSuffix: INamedOption<yargs.Options> = {
    name: "schema-suffix",
    option: {
      describe:
        "A suffix to be appended to output schema names. If unset, the value from workflow_settings.yaml " +
        "is used."
    },
    check: (argv: yargs.Arguments<any>) => {
      if (
        argv[ProjectConfigOptions.schemaSuffix.name] &&
        !/^[a-zA-Z_0-9]+$/.test(argv[ProjectConfigOptions.schemaSuffix.name])
      ) {
        throw new Error(
          `--${ProjectConfigOptions.schemaSuffix.name} should contain only ` +
            `alphanumeric characters and/or underscores.`
        );
      }
    }
  };

  public static tablePrefix: INamedOption<yargs.Options> = {
    name: "table-prefix",
    option: {
      describe:
        "Adds a prefix for all table names. If unset, the value from workflow_settings.yaml is used."
    }
  };

  public static allYargsOptions = [
    ProjectConfigOptions.defaultDatabase,
    ProjectConfigOptions.defaultSchema,
    ProjectConfigOptions.defaultLocation,
    ProjectConfigOptions.assertionSchema,
    ProjectConfigOptions.vars,
    ProjectConfigOptions.databaseSuffix,
    ProjectConfigOptions.schemaSuffix,
    ProjectConfigOptions.tablePrefix
  ];

  public static constructProjectConfigOverride(
    argv: yargs.Arguments<any>
  ): dataform.IProjectConfig {
    const projectConfigOptions: dataform.IProjectConfig = {};

    if (argv[ProjectConfigOptions.defaultDatabase.name]) {
      projectConfigOptions.defaultDatabase = argv[ProjectConfigOptions.defaultDatabase.name];
    }
    if (argv[ProjectConfigOptions.defaultSchema.name]) {
      projectConfigOptions.defaultSchema = argv[ProjectConfigOptions.defaultSchema.name];
    }
    if (argv[ProjectConfigOptions.defaultLocation.name]) {
      projectConfigOptions.defaultLocation = argv[ProjectConfigOptions.defaultLocation.name];
    }
    if (argv[ProjectConfigOptions.assertionSchema.name]) {
      projectConfigOptions.assertionSchema = argv[ProjectConfigOptions.assertionSchema.name];
    }
    if (argv[ProjectConfigOptions.vars.name]) {
      projectConfigOptions.vars = argv[ProjectConfigOptions.vars.name];
    }
    if (argv[ProjectConfigOptions.databaseSuffix.name]) {
      projectConfigOptions.databaseSuffix = argv[ProjectConfigOptions.databaseSuffix.name];
    }
    if (argv[ProjectConfigOptions.schemaSuffix.name]) {
      projectConfigOptions.schemaSuffix = argv[ProjectConfigOptions.schemaSuffix.name];
    }
    if (argv[ProjectConfigOptions.tablePrefix.name]) {
      projectConfigOptions.tablePrefix = argv[ProjectConfigOptions.tablePrefix.name];
    }
    return projectConfigOptions;
  }
}
