'use client';

import { useState, useRef, useEffect, startTransition } from 'react';
import { SafeMessageList } from './safe-message-list';
import { MessageInput } from './message-input';
import type { Message } from '@/types';
import { generateId } from '@/utils';
import { AIProviderFactory } from '@/services/ai/provider-factory';
import { useConversationStore } from '@/store/conversations';
import { useOllama } from '@/hooks/use-ollama';
import { OllamaClientProvider } from '@/services/ai/providers/ollama-client';
import { FileAttachment } from '@/types/attachments';
import { StreamStateManager, StreamState } from '@/services/streaming/stream-state-manager';
import { StreamProgress } from './stream-progress';
import { BranchManager } from '@/services/branching/branch-manager';
import { BranchVisualizer } from './branch-visualizer-v2';
import { compressImage } from '@/utils/image-compression';
import { TemplateModal } from '@/components/templates/template-modal';
import { useUserData } from '@/hooks/use-user-data';
import { useBatteryData } from '@/hooks/use-battery-data';
import { useUserStore } from '@/store/user';
import { EmptyChatView } from '@/components/chat/empty-chat-view';

export function ChatContainer() {
  const {
    currentConversationId,
    createConversation,
    addMessage,
    updateMessage,
    renameConversation,
    conversations,
  } = useConversationStore();
  const { isPremium } = useUserData();
  const {} = useBatteryData();

  // Subscribe to messages separately to ensure reactivity
  const messages = useConversationStore((state) =>
    currentConversationId ? state.messages[currentConversationId] || [] : []
  );

  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState('gpt-4o');
  const [, setStreamingMessage] = useState<string>('');
  const [currentStreamId, setCurrentStreamId] = useState<string | undefined>();
  const [tokensGenerated, setTokensGenerated] = useState(0);
  const [showBranchVisualizer, setShowBranchVisualizer] = useState(false);
  const [, setActiveBranchId] = useState<string>('main');
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [imageGenerationOptions, setImageGenerationOptions] = useState<{
    size?: string;
    quality?: string;
    style?: string;
    n?: number;
    background?: string;
    outputFormat?: string;
    outputCompression?: number;
  }>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const ollamaProviderRef = useRef<OllamaClientProvider | null>(null);
  const isCreatingConversationRef = useRef(false);

  // Get Ollama connection status
  // Initialize with undefined to avoid hydration mismatch
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string | undefined>();

  useEffect(() => {
    // Only access localStorage after mount to avoid SSR issues
    const savedKeys = localStorage.getItem('apiKeys');
    if (savedKeys) {
      const keys = JSON.parse(savedKeys);
      setOllamaBaseUrl(keys.ollama || 'http://localhost:11434');
    } else {
      setOllamaBaseUrl('http://localhost:11434');
    }

    // Load saved model preference
    const savedModel = localStorage.getItem('selectedModel');
    if (savedModel) {
      setSelectedModel(savedModel);
    }
  }, []);

  // Save model preference when it changes
  useEffect(() => {
    if (selectedModel) {
      localStorage.setItem('selectedModel', selectedModel);
    }
  }, [selectedModel]);

  const { isOllamaAvailable } = useOllama(ollamaBaseUrl);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const scrollRAFRef = useRef<number | null>(null);
  const pendingScrollRef = useRef(false);

  const scrollToBottom = (force = false, immediate = false) => {
    // Skip if user manually scrolled away and not forced
    if (!force && !isAtBottomRef.current) {
      return;
    }

    if (immediate && scrollContainerRef.current) {
      // For streaming, just mark that we need to scroll
      pendingScrollRef.current = true;

      // Use RAF to batch scroll updates
      if (!scrollRAFRef.current) {
        scrollRAFRef.current = requestAnimationFrame(() => {
          if (pendingScrollRef.current && scrollContainerRef.current) {
            const container = scrollContainerRef.current;
            // Only scroll if we're not already at the bottom
            const isNearBottom =
              container.scrollHeight - container.scrollTop - container.clientHeight < 100;
            if (!isNearBottom || force) {
              container.scrollTop = container.scrollHeight;
            }
          }
          pendingScrollRef.current = false;
          scrollRAFRef.current = null;
        });
      }
    } else {
      // Cancel any pending immediate scroll
      if (scrollRAFRef.current) {
        cancelAnimationFrame(scrollRAFRef.current);
        scrollRAFRef.current = null;
      }

      // Smooth scroll for other cases
      scrollRAFRef.current = requestAnimationFrame(() => {
        if (messagesEndRef.current) {
          messagesEndRef.current.scrollIntoView({
            behavior: 'smooth',
            block: 'end',
          });
        }
        scrollRAFRef.current = null;
      });
    }
  };

  // Track if user is at the bottom of the scroll container
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;

    // Don't update isAtBottom during streaming to prevent scroll interruption
    if (isLoading) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100; // 100px threshold
    isAtBottomRef.current = isAtBottom;
  };

  // Debounced scroll to bottom to prevent jumping during streaming
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const previousMessageCountRef = useRef(0);

  useEffect(() => {
    // Check if a new message was added (not just updated)
    const newMessageAdded = messages.length > previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;

    // Clear any pending scroll
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // If loading (streaming), use a debounced scroll
    if (isLoading) {
      scrollTimeoutRef.current = setTimeout(() => {
        scrollToBottom();
      }, 100);
    } else if (newMessageAdded) {
      // If not loading and new message added, force scroll
      scrollToBottom(true);
    }

    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [messages, isLoading]);

  // Initialize AI providers from localStorage
  useEffect(() => {
    const savedKeys = localStorage.getItem('apiKeys');
    const keys = savedKeys ? JSON.parse(savedKeys) : {};
    AIProviderFactory.initialize({
      openaiApiKey: keys.openai,
      anthropicApiKey: keys.anthropic,
      googleApiKey: keys.google,
      ollamaBaseUrl: keys.ollama || 'http://localhost:11434',
    });
  }, []);

  // Create conversation if none exists
  useEffect(() => {
    if (!currentConversationId && !isCreatingConversationRef.current) {
      isCreatingConversationRef.current = true;
      createConversation('New Chat', selectedModel)
        .catch(console.error)
        .finally(() => {
          isCreatingConversationRef.current = false;
        });
    }
  }, [currentConversationId, createConversation, selectedModel]);

  const handleImageGeneration = async (
    imageData: {
      type: string;
      url?: string;
      base64?: string;
      model: string;
      prompt: string;
    },
    messageId: string
  ) => {
    try {
      console.log('[ChatContainer] Processing image generation:', imageData);

      let imageBuffer: ArrayBuffer;
      let originalSize: number;

      if (imageData.url) {
        // Download image from URL
        const response = await fetch(imageData.url);
        if (!response.ok) throw new Error('Failed to download image');
        imageBuffer = await response.arrayBuffer();
        originalSize = imageBuffer.byteLength;
      } else if (imageData.base64) {
        // Convert base64 to ArrayBuffer
        const binaryString = atob(imageData.base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        imageBuffer = bytes.buffer;
        originalSize = imageBuffer.byteLength;
      } else {
        throw new Error('No image data provided');
      }

      console.log('[ChatContainer] Original image size:', (originalSize / 1024).toFixed(2), 'KB');

      // Compress the image on client side
      const compressedBuffer = await compressImage(imageBuffer, {
        quality: 0.1, // Very low quality for maximum compression
        maxWidth: 2048,
        maxHeight: 2048,
      });

      const compressedSize = compressedBuffer.byteLength;
      console.log(
        '[ChatContainer] Compressed image size:',
        (compressedSize / 1024).toFixed(2),
        'KB'
      );
      console.log(
        '[ChatContainer] Compression ratio:',
        Math.round((1 - compressedSize / originalSize) * 100),
        '%'
      );

      // Upload compressed image to R2
      const formData = new FormData();
      formData.append('image', new Blob([compressedBuffer], { type: 'image/webp' }));
      formData.append('model', imageData.model);
      formData.append('prompt', imageData.prompt);
      formData.append('originalSize', originalSize.toString());

      const uploadResponse = await fetch('/api/images/upload', {
        method: 'POST',
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload image');
      }

      const result = (await uploadResponse.json()) as { url: string };
      console.log('[ChatContainer] Image uploaded successfully:', result.url);

      // Update the message with the final image URL
      if (currentConversationId) {
        updateMessage(currentConversationId, messageId, `![Generated Image](${result.url})`);
      }
    } catch (error) {
      console.error('[ChatContainer] Error processing image:', error);
      if (currentConversationId) {
        updateMessage(
          currentConversationId,
          messageId,
          `❌ Error processing image: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  };

  const handleSendMessage = async (
    content: string,
    attachments?: FileAttachment[],
    webSearch = false
  ) => {
    if (!currentConversationId) return;

    // Ensure we scroll to bottom when sending a new message
    isAtBottomRef.current = true;
    scrollToBottom(true); // Force scroll immediately

    const userMessage: Message = {
      id: generateId(),
      conversationId: currentConversationId,
      role: 'user',
      content,
      model: selectedModel,
      createdAt: new Date(),
      attachments,
    };

    await addMessage(currentConversationId, userMessage);
    setIsLoading(true);
    setStreamingMessage('');
    setTokensGenerated(0);

    // Create new AbortController for this request
    abortControllerRef.current = new AbortController();

    // Create stream ID for recovery
    const streamId = StreamStateManager.createStreamId();
    setCurrentStreamId(streamId);

    // Create assistant message placeholder
    const assistantMessage: Message = {
      id: generateId(),
      conversationId: currentConversationId,
      role: 'assistant',
      content: '',
      model: selectedModel,
      createdAt: new Date(),
    };

    await addMessage(currentConversationId, assistantMessage);

    // Force scroll to bottom when starting to stream
    isAtBottomRef.current = true;
    scrollToBottom(true); // Use smooth scroll for initial positioning

    let tokenCount = 0; // Move this outside try block for access in finally
    let actualTokenUsage: { inputTokens: number; outputTokens: number } | null = null;

    try {
      let response: Response;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      // Get fresh Ollama URL from localStorage with default
      const savedKeys = localStorage.getItem('apiKeys');
      const currentOllamaUrl = savedKeys ? JSON.parse(savedKeys).ollama : 'http://localhost:11434';

      // Check if this is an Ollama model and if Ollama is available locally
      const isOllamaModel = selectedModel.startsWith('ollama/');

      if (isOllamaModel && isOllamaAvailable && currentOllamaUrl) {
        // Direct browser-to-Ollama connection
        console.log('Using direct Ollama connection for model:', selectedModel);

        if (!ollamaProviderRef.current) {
          ollamaProviderRef.current = new OllamaClientProvider(currentOllamaUrl);
        }

        const streamResponse = await ollamaProviderRef.current.chatCompletion({
          messages: [...messages, userMessage].map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          model: selectedModel,
          stream: true,
          webSearch,
        });

        reader = streamResponse.stream.getReader();
      } else {
        // Server-side API route for cloud providers
        console.log('Using server API route for model:', selectedModel);

        // Get user API keys from localStorage
        const userApiKeys = savedKeys ? JSON.parse(savedKeys) : {};

        response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [...messages, userMessage].map((msg) => ({
              role: msg.role,
              content: msg.content,
            })),
            model: selectedModel,
            stream: true,
            ollamaBaseUrl: isOllamaModel ? currentOllamaUrl : undefined,
            conversationId: currentConversationId,
            webSearch,
            imageGenerationOptions: ['gpt-image-1', 'dall-e-3', 'dall-e-2'].includes(selectedModel)
              ? imageGenerationOptions
              : undefined,
            userApiKeys, // Pass user's API keys
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(error || 'Failed to send message');
        }

        reader = response.body?.getReader();
      }

      // Save initial stream state
      const streamState: StreamState = {
        streamId,
        conversationId: currentConversationId,
        messageId: assistantMessage.id,
        model: selectedModel,
        startedAt: new Date(),
        tokensGenerated: 0,
        messages: [...messages, userMessage].map((msg) => ({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
        })),
      };
      StreamStateManager.saveStreamState(streamState);

      // Handle streaming response
      const decoder = new TextDecoder();

      if (reader) {
        let accumulatedContent = '';
        tokenCount = 0; // Use the outer scope variable
        let lastScrollTime = 0;
        let buffer = ''; // Buffer for incomplete SSE messages

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // Process complete lines only
          const lines = buffer.split('\n');
          // Keep the last line in buffer if it's incomplete
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              if (!data) continue; // Skip empty data lines

              try {
                const parsed = JSON.parse(data);
                console.log('Parsed streaming data:', parsed);

                // Handle usage data from server
                if (parsed.type === 'usage' && parsed.usage) {
                  actualTokenUsage = parsed.usage;
                  console.log('[ChatContainer] Received usage data:', actualTokenUsage);
                  // Update the battery widget with real usage
                  if (actualTokenUsage) {
                    setTokensGenerated(
                      actualTokenUsage.inputTokens + actualTokenUsage.outputTokens
                    );
                  }

                  // Update battery balance if included
                  if (parsed.battery) {
                    console.log('[ChatContainer] Updating battery balance:', parsed.battery);
                    const store = useUserStore.getState();
                    store.updateBatteryBalance(
                      parsed.battery.newBalance,
                      parsed.battery.batteryUsed
                    );
                  }

                  continue; // Don't process usage data as content
                }

                // Handle different response formats
                let content = '';
                if (parsed.content) {
                  content = parsed.content;
                } else if (parsed.choices?.[0]?.delta?.content) {
                  content = parsed.choices[0].delta.content;

                  // Check if this is image generation metadata
                  try {
                    const possibleImageData = JSON.parse(content);
                    if (possibleImageData.type === 'image_generation') {
                      // Handle image generation on client side
                      handleImageGeneration(possibleImageData, assistantMessage.id);
                      content = '🎨 Generating and compressing image...';
                      accumulatedContent = '';
                    }
                  } catch {
                    // Not JSON, just regular content
                  }
                } else if (parsed.choices?.[0]?.delta?.image_data) {
                  // Legacy handling for base64 image data
                  const imageData = parsed.choices[0].delta.image_data;
                  if (imageData.type === 'base64' && imageData.data) {
                    // Replace the placeholder with the actual base64 image
                    content = `![Generated Image](data:image/png;base64,${imageData.data})`;
                    // Clear the accumulated content to replace the placeholder
                    accumulatedContent = '';
                  }
                }

                if (content) {
                  accumulatedContent += content;

                  // For image generation, don't calculate tokens based on base64 data
                  const isImageContent = content.includes('![Generated Image]');
                  if (!isImageContent && !actualTokenUsage) {
                    // Only do rough estimate if we don't have actual usage from server
                    tokenCount += content.split(/\s+/).length; // Rough token estimate
                    setTokensGenerated(tokenCount);
                  }

                  // Debug logging for image content
                  if (isImageContent) {
                    console.log('[ChatContainer] Received image content, length:', content.length);
                    console.log(
                      '[ChatContainer] Accumulated content preview:',
                      accumulatedContent.substring(0, 100)
                    );
                  }

                  setStreamingMessage(accumulatedContent);

                  // Update the assistant message with startTransition for better performance
                  // For large image data, use requestIdleCallback to avoid blocking
                  if (isImageContent && accumulatedContent.length > 10000) {
                    if ('requestIdleCallback' in window) {
                      requestIdleCallback(
                        () => {
                          updateMessage(
                            currentConversationId,
                            assistantMessage.id,
                            accumulatedContent
                          );
                        },
                        { timeout: 1000 }
                      );
                    } else {
                      // Fallback with setTimeout for browsers that don't support requestIdleCallback
                      setTimeout(() => {
                        updateMessage(
                          currentConversationId,
                          assistantMessage.id,
                          accumulatedContent
                        );
                      }, 0);
                    }
                  } else {
                    startTransition(() => {
                      updateMessage(currentConversationId, assistantMessage.id, accumulatedContent);
                    });
                  }

                  // Throttle scrolling to prevent UI lockup
                  const now = Date.now();
                  if (now - lastScrollTime > 100) {
                    // Scroll at most every 100ms
                    lastScrollTime = now;
                    scrollToBottom(false, true);
                  }

                  // Periodically save stream state (skip for large image data)
                  if (!isImageContent && tokenCount % 10 === 0) {
                    streamState.tokensGenerated = tokenCount;
                    streamState.lastChunkAt = new Date();
                    StreamStateManager.saveStreamState(streamState);
                  }
                }
              } catch (e) {
                console.error('Error parsing streaming data:', e, 'Line:', line);
              }
            }
          }
        }

        // Process any remaining buffer
        if (buffer.trim() && buffer.startsWith('data: ')) {
          const data = buffer.slice(6).trim();
          if (data && data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data);
              const content = parsed.content || parsed.choices?.[0]?.delta?.content;
              if (content) {
                accumulatedContent += content;
              }
            } catch (e) {
              console.error('Error parsing final buffer:', e, 'Buffer:', buffer);
            }
          }
        }

        // Mark stream as complete
        StreamStateManager.markStreamComplete(streamId);

        // Ensure final content is saved
        if (accumulatedContent) {
          console.log(
            '[ChatContainer] Final accumulated content length:',
            accumulatedContent.length
          );
          console.log(
            '[ChatContainer] Final content preview:',
            accumulatedContent.substring(0, 200)
          );
          updateMessage(currentConversationId, assistantMessage.id, accumulatedContent);
        }

        // Final scroll to ensure we're at the bottom
        scrollToBottom(true);

        // Auto-update conversation title after first exchange
        const currentConversation = conversations.find((c) => c.id === currentConversationId);
        // Get fresh messages from store state
        const currentMessages =
          useConversationStore.getState().messages[currentConversationId] || [];

        if (
          currentConversation &&
          currentConversation.title === 'New Chat' &&
          currentMessages.length === 2 // User message + AI response
        ) {
          // Generate a concise title summarizing the conversation
          const firstUserMessage = currentMessages[0]?.content || userMessage.content;

          // Create a title based on the user's question
          let newTitle = '';

          // Extract key topics from the user message
          const lowerMessage = firstUserMessage.toLowerCase();

          // Common question patterns
          if (lowerMessage.includes('how to') || lowerMessage.includes('how do')) {
            newTitle = firstUserMessage.split(/how to|how do/i)[1]?.trim() || '';
            if (newTitle) newTitle = 'How to ' + newTitle;
          } else if (lowerMessage.includes('what is') || lowerMessage.includes('what are')) {
            newTitle = firstUserMessage.split(/what is|what are/i)[1]?.trim() || '';
            if (newTitle) newTitle = 'About ' + newTitle;
          } else if (lowerMessage.includes('why')) {
            newTitle = 'Why ' + firstUserMessage.split(/why/i)[1]?.trim();
          } else if (lowerMessage.includes('can you') || lowerMessage.includes('could you')) {
            newTitle = firstUserMessage.split(/can you|could you/i)[1]?.trim() || '';
            if (newTitle) newTitle = newTitle.charAt(0).toUpperCase() + newTitle.slice(1);
          } else if (lowerMessage.includes('help')) {
            newTitle = 'Help with ' + firstUserMessage.split(/help/i)[1]?.trim();
          } else {
            // For other cases, extract the main topic (first few meaningful words)
            const words = firstUserMessage
              .replace(/[?!.,;:]/g, '')
              .split(' ')
              .filter((word) => word.length > 2);
            newTitle = words.slice(0, 4).join(' ');
          }

          // Clean up and limit title length
          newTitle = newTitle
            .replace(/[?!.,;:]+$/, '') // Remove trailing punctuation
            .trim()
            .slice(0, 30);

          // If title is too short or empty, use a truncated version of the message
          if (!newTitle || newTitle.length < 3) {
            newTitle = firstUserMessage.slice(0, 30);
          }

          // Ensure title ends cleanly
          if (newTitle.length === 30 && !newTitle.endsWith(' ')) {
            const lastSpace = newTitle.lastIndexOf(' ');
            if (lastSpace > 20) {
              newTitle = newTitle.slice(0, lastSpace);
            }
          }

          renameConversation(currentConversationId, newTitle);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Request aborted');
        StreamStateManager.markStreamAborted(streamId, 'User cancelled');
      } else {
        console.error('Error sending message:', error);
        // Update the existing assistant message with error
        const errorContent = `⚠️ Error: ${error instanceof Error ? error.message : 'Unknown error'}`;

        // For image generation errors, provide more helpful message
        if (['gpt-image-1', 'dall-e-3', 'dall-e-2'].includes(selectedModel)) {
          const detailedError =
            error instanceof Error && error.message.includes('API')
              ? '⚠️ Failed to generate image. Please check your API key and try again.'
              : errorContent;
          updateMessage(currentConversationId, assistantMessage.id, detailedError);
          StreamStateManager.markStreamError(streamId, detailedError);
        } else {
          updateMessage(currentConversationId, assistantMessage.id, errorContent);
          StreamStateManager.markStreamError(streamId, errorContent);
        }
      }
    } finally {
      setIsLoading(false);
      setStreamingMessage('');
      setCurrentStreamId(undefined);

      // Usage tracking is now handled server-side
      // The server sends accurate token counts and updates the database
      if (actualTokenUsage) {
        console.log('[ChatContainer] Stream completed with token usage:', actualTokenUsage);
        // Battery data will auto-refresh via the periodic interval in useBatteryData hook
      }

      setTokensGenerated(0);
      abortControllerRef.current = null;
    }
  };

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (ollamaProviderRef.current) {
      ollamaProviderRef.current.abort();
    }
    if (currentStreamId) {
      StreamStateManager.markStreamAborted(currentStreamId, 'User stopped generation');
    }
  };

  const handleRegenerateMessage = async (index: number) => {
    if (!currentConversationId || isLoading) return;

    // Get current messages
    const messagesArray = messages;
    if (index !== messagesArray.length - 1 || messagesArray[index].role !== 'assistant') return;

    // Delete the last assistant message
    const assistantMessage = messagesArray[index];
    const conversationStore = useConversationStore.getState();
    conversationStore.deleteMessage(currentConversationId, assistantMessage.id);

    // For branched messages, we need to get the correct conversation path
    // Build the conversation path that led to this message
    const messagesToSend: Message[] = [];

    // Start from the assistant message we're regenerating and work backwards
    let currentMsg = assistantMessage;
    const pathToRoot: Message[] = [];

    // Find the path from this message back to the root
    while (currentMsg) {
      // Find the parent message
      const parentMsg = messagesArray.find((m) =>
        currentMsg.parentId ? m.id === currentMsg.parentId : false
      );

      if (parentMsg) {
        pathToRoot.unshift(parentMsg);
        currentMsg = parentMsg;
      } else {
        // No parent found, we've reached a root
        break;
      }
    }

    // If we didn't find a path (no parentId), use all messages up to the deleted one
    if (pathToRoot.length === 0) {
      messagesToSend.push(...messagesArray.slice(0, index));
    } else {
      messagesToSend.push(...pathToRoot);
    }

    console.log('[Regenerate] Messages to send:', messagesToSend.length);
    console.log(
      '[Regenerate] Message path:',
      messagesToSend.map((m) => ({ id: m.id, role: m.role, content: m.content.substring(0, 50) }))
    );

    // Regenerate response
    setIsLoading(true);
    setStreamingMessage('');
    isAtBottomRef.current = true; // Ensure scrolling during regeneration
    abortControllerRef.current = new AbortController();

    try {
      let response: Response;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      // Get fresh Ollama URL from localStorage with default
      const savedKeys = localStorage.getItem('apiKeys');
      const currentOllamaUrl = savedKeys ? JSON.parse(savedKeys).ollama : 'http://localhost:11434';

      // Check if this is an Ollama model and if Ollama is available locally
      const isOllamaModel = selectedModel.startsWith('ollama/');

      if (isOllamaModel && isOllamaAvailable && currentOllamaUrl) {
        // Direct browser-to-Ollama connection
        console.log('Using direct Ollama connection for regeneration:', selectedModel);

        if (!ollamaProviderRef.current) {
          ollamaProviderRef.current = new OllamaClientProvider(currentOllamaUrl);
        }

        const streamResponse = await ollamaProviderRef.current.chatCompletion({
          messages: messagesToSend.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          model: selectedModel,
          stream: true,
        });

        reader = streamResponse.stream.getReader();
      } else {
        // Server-side API route for cloud providers
        response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messagesToSend.map((msg) => ({
              role: msg.role,
              content: msg.content,
            })),
            model: selectedModel,
            stream: true,
            ollamaBaseUrl: isOllamaModel ? currentOllamaUrl : undefined,
            conversationId: currentConversationId,
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error('Failed to regenerate message');
        }

        reader = response.body?.getReader();
      }

      // Create new assistant message placeholder with same parentId as deleted message
      const newAssistantMessage: Message = {
        id: generateId(),
        conversationId: currentConversationId,
        role: 'assistant',
        content: '',
        model: selectedModel,
        parentId: assistantMessage.parentId, // Maintain the same parent relationship
        createdAt: new Date(),
      };

      await addMessage(currentConversationId, newAssistantMessage);

      // Force scroll when starting regeneration
      scrollToBottom(true);

      // Handle streaming response (same as in handleSendMessage)
      const decoder = new TextDecoder();

      if (reader) {
        let accumulatedContent = '';
        let lastScrollTime = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);

                // Handle different response formats
                let content = '';
                if (parsed.content) {
                  content = parsed.content;
                } else if (parsed.choices?.[0]?.delta?.content) {
                  content = parsed.choices[0].delta.content;
                } else if (parsed.choices?.[0]?.delta?.image_data) {
                  // Special handling for base64 image data
                  const imageData = parsed.choices[0].delta.image_data;
                  if (imageData.type === 'base64' && imageData.data) {
                    // Replace the placeholder with the actual base64 image
                    content = `![Generated Image](data:image/png;base64,${imageData.data})`;
                    // Clear the accumulated content to replace the placeholder
                    accumulatedContent = '';
                  }
                } else if (parsed.message?.content) {
                  // Ollama format
                  content = parsed.message.content;
                } else if (parsed.done === false && parsed.response) {
                  // Another Ollama format
                  content = parsed.response;
                }

                if (content) {
                  accumulatedContent += content;
                  setStreamingMessage(accumulatedContent);
                  startTransition(() => {
                    updateMessage(
                      currentConversationId,
                      newAssistantMessage.id,
                      accumulatedContent
                    );
                  });

                  // Throttle scrolling
                  const now = Date.now();
                  if (now - lastScrollTime > 100) {
                    lastScrollTime = now;
                    scrollToBottom(false, true);
                  }
                }
              } catch (e) {
                console.error('Error parsing streaming data in regenerate:', e);
              }
            }
          }
        }

        // Final scroll after regeneration completes
        scrollToBottom(true);
      }
    } catch (error) {
      console.error('Error regenerating message:', error);
    } finally {
      setIsLoading(false);
      setStreamingMessage('');
      abortControllerRef.current = null;
    }
  };

  const handleBranchSwitch = (targetBranchId: string) => {
    // Build the message tree
    const tree = BranchManager.buildMessageTree(messages);

    // Switch to the target branch
    const updatedTree = BranchManager.switchToBranch(tree, targetBranchId);

    // Get the active path
    BranchManager.getActivePath(updatedTree);

    // Update the active branch ID
    setActiveBranchId(targetBranchId);

    // Scroll to bottom
    scrollToBottom();
  };

  const handleCreateBranch = async (fromMessageId: string) => {
    if (!currentConversationId || isLoading || creatingBranch) return;

    setCreatingBranch(true);

    // Find the message to branch from
    const messageIndex = messages.findIndex((m) => m.id === fromMessageId);
    if (messageIndex === -1) {
      console.error('[Branch] Message not found:', fromMessageId);
      setCreatingBranch(false);
      return;
    }

    console.log('[Branch] Creating branch from message at index:', messageIndex);
    console.log('[Branch] Message role:', messages[messageIndex].role);

    // Get the message we're branching from
    // const branchFromMessage = messages[messageIndex];

    // Find the user message that prompted this assistant response
    let previousUserMessage = null;
    for (let i = messageIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        previousUserMessage = messages[i];
        break;
      }
    }

    if (!previousUserMessage) {
      console.error('[Branch] No previous user message found for message:', fromMessageId);
      setCreatingBranch(false);
      return;
    }

    // Get messages up to and including the user message before the branch point
    const messagesToSend = messages.slice(0, messages.indexOf(previousUserMessage) + 1);

    // Trigger AI response
    setIsLoading(true);
    setStreamingMessage('');

    const assistantMessage: Message = {
      id: generateId(),
      conversationId: currentConversationId,
      role: 'assistant',
      content: '🌿 Generating alternative response...',
      model: selectedModel,
      parentId: previousUserMessage.id, // Branch from the user message
      createdAt: new Date(),
    };

    await addMessage(currentConversationId, assistantMessage);

    // Force scroll to bottom when starting branch creation
    isAtBottomRef.current = true;
    scrollToBottom(true);

    // Send request for alternative response
    try {
      // Prepare messages - add instruction to the last user message for variety
      const messagesForBranch = messagesToSend.map((m, idx) => {
        if (idx === messagesToSend.length - 1 && m.role === 'user') {
          return {
            role: m.role as 'user' | 'assistant' | 'system',
            content:
              m.content +
              '\n\n[Please provide an alternative response with a different perspective, approach, or style. Be creative and offer a unique take on this request.]',
          };
        }
        return { role: m.role as 'user' | 'assistant' | 'system', content: m.content };
      });

      console.log('[Branch] Sending request with messages:', messagesForBranch.length);
      console.log('[Branch] Using model:', selectedModel);
      console.log('[Branch] Conversation ID:', currentConversationId);

      // Get Ollama base URL if using Ollama model
      const savedKeys = localStorage.getItem('apiKeys');
      const currentOllamaUrl = savedKeys ? JSON.parse(savedKeys).ollama : 'http://localhost:11434';
      const isOllamaModel = selectedModel.startsWith('ollama/');

      console.log('[Branch] Is Ollama model:', isOllamaModel);
      console.log('[Branch] Ollama base URL:', isOllamaModel ? currentOllamaUrl : 'N/A');
      console.log('[Branch] Messages to send:', messagesForBranch);

      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      // For Ollama models, check if direct connection is available
      if (isOllamaModel && isOllamaAvailable && currentOllamaUrl) {
        console.log('[Branch] Using direct Ollama connection');
        if (!ollamaProviderRef.current) {
          ollamaProviderRef.current = new OllamaClientProvider(currentOllamaUrl);
        }

        const streamResponse = await ollamaProviderRef.current.chatCompletion({
          messages: messagesForBranch,
          model: selectedModel,
          stream: true,
          temperature: 0.9,
        });

        reader = streamResponse.stream.getReader();
      } else {
        console.log('[Branch] Using server API route');
        response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messagesForBranch,
            model: selectedModel,
            stream: true,
            conversationId: currentConversationId,
            temperature: 0.9, // Higher temperature for more variety
            ollamaBaseUrl: isOllamaModel ? currentOllamaUrl : undefined,
          }),
        });

        console.log('[Branch] Response status:', response.status);
        console.log('[Branch] Response headers:', Object.fromEntries(response.headers.entries()));

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[Branch] Error response:', errorText);
          throw new Error(`Failed to create branch: ${response.status} ${errorText}`);
        }

        reader = response.body?.getReader();
      }

      const decoder = new TextDecoder();

      if (reader) {
        let accumulatedContent = '';
        let isFirstChunk = true;
        let lastScrollTime = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);
                let content = '';
                if (parsed.content) {
                  content = parsed.content;
                } else if (parsed.choices?.[0]?.delta?.content) {
                  content = parsed.choices[0].delta.content;
                } else if (parsed.message?.content) {
                  // Ollama format
                  content = parsed.message.content;
                } else if (parsed.done === false && parsed.response) {
                  // Another Ollama format
                  content = parsed.response;
                }

                if (content) {
                  if (isFirstChunk) {
                    // Clear the loading message on first content
                    accumulatedContent = content;
                    isFirstChunk = false;
                  } else {
                    accumulatedContent += content;
                  }
                  startTransition(() => {
                    updateMessage(currentConversationId, assistantMessage.id, accumulatedContent);
                  });

                  // Throttle scrolling
                  const now = Date.now();
                  if (now - lastScrollTime > 100) {
                    lastScrollTime = now;
                    scrollToBottom(false, true);
                  }
                }
              } catch (e) {
                console.error('[Branch] Error parsing SSE data:', data);
                console.error('[Branch] Parse error:', e);
              }
            }
          }
        }

        // Final scroll after branch creation completes
        scrollToBottom(true);
      }
    } catch (error) {
      console.error('[Branch] Error creating branch:', error);
      console.error('[Branch] Error stack:', error instanceof Error ? error.stack : 'No stack');
      // Update the message with error information
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to generate alternative response';
      updateMessage(currentConversationId, assistantMessage.id, `⚠️ ${errorMessage}`);
    } finally {
      setIsLoading(false);
      setStreamingMessage('');
      setCreatingBranch(false);
    }
  };

  // Get filtered messages based on active branch
  const filteredMessages = messages; // For now, show all messages. In production, filter by branch.

  return (
    <div className="flex h-full bg-white dark:bg-gray-900">
      {/* Branch Visualizer Sidebar */}
      {showBranchVisualizer && messages.length > 0 && (
        <div className="w-full flex-shrink-0 border-r border-gray-200 bg-white md:w-96 lg:w-[28rem] dark:border-gray-700 dark:bg-gray-900">
          <BranchVisualizer
            messages={messages}
            onBranchSwitch={handleBranchSwitch}
            onCreateBranch={handleCreateBranch}
            onClose={() => setShowBranchVisualizer(false)}
            isCreatingBranch={creatingBranch}
            className="h-full"
          />
        </div>
      )}

      {/* Main Chat Area */}
      <div className="relative flex flex-1 flex-col">
        {/* Messages */}
        <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          {messages.length === 0 && !isLoading ? (
            <EmptyChatView
              isPremium={isPremium}
              onTemplateClick={() => setShowTemplateDialog(true)}
            />
          ) : (
            <>
              <SafeMessageList
                messages={filteredMessages}
                isLoading={isLoading}
                currentModel={selectedModel}
                imageGenerationOptions={imageGenerationOptions}
                onRegenerateMessage={handleRegenerateMessage}
                onBranchSwitch={handleBranchSwitch}
                onCreateBranch={handleCreateBranch}
              />
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Stream Progress */}
        {isLoading && (
          <StreamProgress
            streamId={currentStreamId}
            isStreaming={isLoading}
            tokensGenerated={tokensGenerated}
          />
        )}

        {/* Input */}
        <MessageInput
          onSendMessage={handleSendMessage}
          isLoading={isLoading}
          onStop={handleStopGeneration}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          conversationId={currentConversationId || ''}
          onToggleBranches={
            messages.length > 0 ? () => setShowBranchVisualizer(!showBranchVisualizer) : undefined
          }
          showBranches={showBranchVisualizer}
          imageGenerationOptions={imageGenerationOptions}
          onImageParamsChange={setImageGenerationOptions}
        />
      </div>

      {/* Template Modal */}
      <TemplateModal open={showTemplateDialog} onClose={() => setShowTemplateDialog(false)} />
    </div>
  );
}
