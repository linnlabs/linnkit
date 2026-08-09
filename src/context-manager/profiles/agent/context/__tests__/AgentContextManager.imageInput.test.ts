import { describe, expect, it, vi } from 'vitest';
import {
  defineContextPolicy,
  type AiMessage,
  type TokenRoute,
} from '../../../../../contracts';
import type {
  LlmImageInputEstimatorPort,
  TokenCounterPort,
  TokenizerPort,
} from '../../../../../ports';
import { AgentContextManager } from '../AgentContextManager';
import {
  AgentCoreContextProvider,
  ContextProviderRegistry,
} from '../providers';

const imageRef = {
  id: 'attachment-1',
  kind: 'image' as const,
  resourceId: 'asset-1',
  mediaType: 'image/png' as const,
  byteLength: 128,
  width: 16,
  height: 8,
  sha256: 'a'.repeat(64),
};

const route: TokenRoute = {
  providerId: 'test',
  modelId: 'vision-model',
  capabilities: { supportsRemoteTokenCount: true },
};

const tokenizer: TokenizerPort = {
  estimateText: () => 5,
  estimateMessage: () => 5,
};

const estimator: LlmImageInputEstimatorPort = {
  estimateImageInput: vi.fn(() => ({
    estimatedTokens: 100,
    profileId: 'vision-profile',
    estimatorVersion: 'test-v1',
  })),
};

function createManager(tokenCounter: TokenCounterPort): AgentContextManager {
  const registry = new ContextProviderRegistry();
  registry.register(new AgentCoreContextProvider());
  return new AgentContextManager({
    providerRegistry: registry,
    tokenizer,
    tokenizerModelId: route.modelId,
    tokenRoute: route,
    tokenCounter,
    remoteCount: { enabled: true, failureBehavior: 'use-local-estimate' },
    imageInputEstimator: estimator,
  });
}

describe('AgentContextManager image input budget', () => {
  it('图片-only 消息按整条消息参与预算，并从同一估算拆出 component 与 admission evidence', async () => {
    const countMessages = vi.fn<TokenCounterPort['countMessages']>();
    const manager = createManager({ countMessages });
    const policy = defineContextPolicy({ contextTrace: { enabled: true } });
    const messages: AiMessage[] = [
      {
        id: 'system-1',
        role: 'system',
        type: 'system_prompt',
        content: 'system',
        timestamp: 1,
      },
      {
        id: 'user-image',
        role: 'user',
        type: 'user_input',
        content: '',
        timestamp: 2,
        attachments: [imageRef],
      },
    ];

    const result = await manager.buildContextFromPreprocessedMessages(
      { promptKey: 'default', query: '' },
      messages,
      200,
      undefined,
      undefined,
      undefined,
      {
        policy: policy.contextTrace,
        effectiveContextPolicy: policy,
      },
    );

    expect(result.messages.map(message => message.id)).toEqual(['system-1', 'user-image']);
    expect(result.tokenUsage.used).toBe(110);
    expect(result.tokenComponents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        componentId: '1:user-image',
        kind: 'user',
        tokens: 5,
        kept: true,
      }),
      expect.objectContaining({
        componentId: '1:user-image:image:0',
        kind: 'image-attachment',
        tokens: 100,
        messageId: 'user-image',
        attachmentId: imageRef.id,
        resourceId: imageRef.resourceId,
        placement: 'user_image',
        profileId: 'vision-profile',
        estimatorVersion: 'test-v1',
        kept: true,
      }),
    ]));
    expect(result.tokenComponents?.reduce((total, component) => total + component.tokens, 0)).toBe(110);
    expect(result.imageInputAdmissionEvidence).toEqual({
      inputBudget: 200,
      nonImageEstimatedTokens: 10,
      initialProfileId: 'vision-profile',
      attachments: [{
        messageIndex: 1,
        attachmentIndex: 0,
        id: imageRef.id,
        resourceId: imageRef.resourceId,
        placement: 'user_image',
        estimatedTokens: 100,
      }],
    });
    expect(result.contextTrace?.tokenComponents).toEqual(result.tokenComponents);
  });

  it('含图时不调用 pre-materialization remote counter，并记录稳定 local-only 原因', async () => {
    const countMessages = vi.fn<TokenCounterPort['countMessages']>();
    const manager = createManager({ countMessages });
    const policy = defineContextPolicy({ contextTrace: { enabled: true } });

    const result = await manager.buildContextFromPreprocessedMessages(
      { promptKey: 'default', query: '' },
      [{
        id: 'user-image',
        role: 'user',
        type: 'user_input',
        content: '',
        timestamp: 1,
        attachments: [imageRef],
      }],
      200,
      undefined,
      undefined,
      undefined,
      {
        policy: policy.contextTrace,
        effectiveContextPolicy: policy,
      },
    );

    expect(countMessages).not.toHaveBeenCalled();
    expect(result.contextTrace?.remoteTokenCount).toMatchObject({
      enabled: true,
      attempted: false,
      applied: false,
      localEstimateTokens: 105,
      skipReason: 'image_input_local_only',
    });
  });

  it('图片屏障保留后仍超出预算时抛出原始结构化错误，不再被通用 Error 包装', async () => {
    const manager = createManager({ countMessages: vi.fn() });

    await expect(manager.buildContextFromPreprocessedMessages(
      { promptKey: 'default', query: '' },
      [{
        id: 'user-image',
        role: 'user',
        type: 'user_input',
        content: '',
        timestamp: 1,
        attachments: [imageRef],
      }],
      100,
    )).rejects.toMatchObject({
      name: 'LlmImageInputError',
      errorCode: 'llm.image_input.context_budget_exceeded',
      recoverable: false,
      metadata: {
        active_model_id: 'vision-model',
        placement: 'user_image',
        attachment_id: imageRef.id,
        resource_id: imageRef.resourceId,
        profile_id: 'vision-profile',
        limit_kind: 'context_tokens',
        actual_value: 105,
        limit_value: 100,
      },
    });
  });
});
