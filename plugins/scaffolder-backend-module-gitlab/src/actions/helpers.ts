/*
 * Copyright 2023 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  SerializedFile,
  parseRepoUrl,
  serializeDirectoryContents,
} from '@backstage/plugin-scaffolder-node';
import { InputError } from '@backstage/errors';
import { Gitlab } from '@gitbeaker/node';
import { ScmIntegrationRegistry } from '@backstage/integration';
import { Resources, Types } from '@gitbeaker/core';
import {
  LoggerService,
  resolveSafeChildPath,
} from '../../../../packages/backend-plugin-api/src';
import { createHash } from 'crypto';
import path from 'path';

export function createGitlabApi(options: {
  integrations: ScmIntegrationRegistry;
  token?: string;
  repoUrl: string;
}): Resources.Gitlab {
  const { integrations, token: providedToken, repoUrl } = options;

  const { host } = parseRepoUrl(repoUrl, integrations);

  const integrationConfig = integrations.gitlab.byHost(host);

  if (!integrationConfig) {
    throw new InputError(
      `No matching integration configuration for host ${host}, please check your integrations config`,
    );
  }

  if (!integrationConfig.config.token && !providedToken) {
    throw new InputError(`No token available for host ${host}`);
  }

  const token = providedToken ?? integrationConfig.config.token!;
  const tokenType = providedToken ? 'oauthToken' : 'token';

  return new Gitlab({
    host: integrationConfig.config.baseUrl,
    [tokenType]: token,
  });
}

function computeSha256(file: SerializedFile): string {
  const hash = createHash('sha256');
  hash.update(file.content);
  return hash.digest('hex');
}

type CommitAction = 'create' | 'delete' | 'update' | 'skip' | 'auto';

async function getFileAction(
  fileInfo: { file: SerializedFile; targetPath?: string },
  target: { repoID: string; branch: string },
  api: Gitlab,
  remoteFiles: Types.RepositoryTreeSchema[],
  defaultCommitAction: CommitAction = 'auto',
): Promise<Omit<CommitAction, 'auto'>> {
  if (defaultCommitAction === 'auto') {
    const filePath = path.join(fileInfo.targetPath ?? '', fileInfo.file.path);

    if (remoteFiles?.some(remoteFile => remoteFile.path === filePath)) {
      const targetFile = await api.RepositoryFiles.show(
        target.repoID,
        filePath,
        target.branch,
      );
      if (computeSha256(fileInfo.file) === targetFile.content_sha256) {
        return 'skip';
      }
      return 'update';
    }
    return 'create';
  }
  return defaultCommitAction;
}

export async function getCommitActions(
  gitlab: Resources.Gitlab,
  repoID: string,
  workspacePath: string,
  sourcePath: string,
  targetBranch: string,
  targetPath: string,
  commitAction: CommitAction = 'auto',
): Promise<Types.CommitAction[]> {
  if (sourcePath) {
    fileRoot = resolveSafeChildPath(workspacePath, sourcePath);
  } else if (targetPath) {
    // for backward compatibility
    fileRoot = resolveSafeChildPath(workspacePath, targetPath);
  } else {
    fileRoot = workspacePath;
  }

  let remoteFiles: Types.RepositoryTreeSchema[] = [];
  if ((commitAction ?? 'auto') === 'auto') {
    remoteFiles = await gitlab.Repositories.tree(repoID, {
      ref: targetBranch,
      recursive: true,
      path: targetPath ?? undefined,
    });
  }
  const fileContents = await serializeDirectoryContents(fileRoot, {
    gitignore: true,
  });

  return commitAction === 'skip'
    ? []
    : (
        (
          await Promise.all(
            fileContents.map(async file => {
              const action = await getFileAction(
                { file, targetPath },
                { repoID, branch: targetBranch! },
                gitlab,
                remoteFiles,
                commitAction,
              );
              return { file, action };
            }),
          )
        ).filter(o => o.action !== 'skip') as {
          file: SerializedFile;
          action: Types.CommitAction['action'];
        }[]
      ).map(({ file, action }) => ({
        action,
        filePath: targetPath
          ? path.posix.join(targetPath, file.path)
          : file.path,
        encoding: 'base64',
        content: file.content.toString('base64'),
        execute_filemode: file.executable,
      }));
}
