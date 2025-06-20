import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Conversation, Message } from '@/types';
import { generateId } from '@/utils';
import { offlineStorage } from '@/services/storage/offline';
import { syncService } from '@/services/storage/sync';
import { migrateMessage, migrateConversation } from '@/lib/migrations/client-migrations';

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Record<string, Message[]>; // conversationId -> messages
  isLoading: boolean;
  isSyncing: boolean;
  recentlyDeletedIds: Set<string>; // Track deleted conversations to prevent re-sync

  // Actions
  createConversation: (title?: string, model?: string) => Promise<Conversation>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => void;
  setCurrentConversation: (id: string | null) => void;

  // Message actions
  addMessage: (conversationId: string, message: Message) => Promise<void>;
  updateMessage: (conversationId: string, messageId: string, content: string) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  getMessages: (conversationId: string) => Message[];

  // Sync actions
  syncConversations: () => Promise<void>;
  syncMessages: (conversationId: string) => Promise<void>;

  // Utils
  getCurrentConversation: () => Conversation | null;
  clearConversationMessages: (conversationId: string) => void;
}

export const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      conversations: [],
      currentConversationId: null,
      messages: {},
      isLoading: false,
      isSyncing: false,
      recentlyDeletedIds: new Set(),

      createConversation: async (title, model = 'gpt-4o') => {
        const tempId = generateId();
        const conversation: Conversation = {
          id: tempId,
          userId: 'current-user',
          title: title || 'New Chat',
          model,
          createdAt: new Date(),
          updatedAt: new Date(),
          isArchived: false,
        };

        // Optimistically add to store
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          currentConversationId: conversation.id,
          messages: { ...state.messages, [conversation.id]: [] },
        }));

        // Save to offline storage
        await offlineStorage.saveConversation(conversation);

        // Try to persist to database
        try {
          const response = await fetch('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: conversation.title, model: conversation.model }),
          });

          if (response.ok) {
            const { conversation: dbConversation } = (await response.json()) as {
              conversation: Conversation;
            };
            // Update with real ID from database
            set((state) => ({
              conversations: state.conversations.map((c) =>
                c.id === tempId
                  ? {
                      ...dbConversation,
                      createdAt: new Date(dbConversation.createdAt),
                      updatedAt: new Date(dbConversation.updatedAt),
                    }
                  : c
              ),
              currentConversationId: dbConversation.id,
              messages: {
                ...state.messages,
                [dbConversation.id]: (state.messages[tempId] || []).map((msg) => ({
                  ...msg,
                  conversationId: dbConversation.id,
                })),
              },
            }));
            // Clean up temp ID
            set((state) => {
              const newMessages = { ...state.messages };
              delete newMessages[tempId];
              return { messages: newMessages };
            });
            return dbConversation;
          }
        } catch (error) {
          console.error('Failed to persist conversation:', error);
          // Add to sync queue for later
          await offlineStorage.addToSyncQueue({
            type: 'create_conversation',
            data: { title: conversation.title, model: conversation.model },
          });
        }

        return conversation;
      },

      deleteConversation: async (id) => {
        // Optimistically remove from store and track deletion
        set((state) => {
          const newConversations = state.conversations.filter((c) => c.id !== id);
          const newMessages = { ...state.messages };
          delete newMessages[id];

          // Add to recently deleted to prevent re-sync
          const newRecentlyDeletedIds = new Set(state.recentlyDeletedIds);
          newRecentlyDeletedIds.add(id);

          return {
            conversations: newConversations,
            currentConversationId:
              state.currentConversationId === id ? null : state.currentConversationId,
            messages: newMessages,
            recentlyDeletedIds: newRecentlyDeletedIds,
          };
        });

        // Remove from offline storage
        await offlineStorage.deleteConversation(id);

        // Try to delete from server
        try {
          const response = await fetch(`/api/conversations/${id}`, {
            method: 'DELETE',
          });

          if (!response.ok) {
            // If server deletion fails, add back to store
            console.error('Failed to delete conversation from server');

            // Optionally restore the conversation
            // But for now we'll keep it deleted locally and add to sync queue
          } else {
            // Clear from recently deleted after successful server deletion
            setTimeout(() => {
              set((state) => {
                const newRecentlyDeletedIds = new Set(state.recentlyDeletedIds);
                newRecentlyDeletedIds.delete(id);
                return { recentlyDeletedIds: newRecentlyDeletedIds };
              });
            }, 5000); // Keep for 5 seconds to handle immediate re-syncs
          }
        } catch (error) {
          console.error('Failed to delete conversation:', error);
          // Add to sync queue for later
          await offlineStorage.addToSyncQueue({
            type: 'delete_conversation',
            data: { id },
          });
        }
      },

      renameConversation: (id, title) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: new Date() } : c
          ),
        }));
      },

      setCurrentConversation: (id) => {
        set({ currentConversationId: id });
      },

      addMessage: async (conversationId, message) => {
        // Optimistically add to store
        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: [...(state.messages[conversationId] || []), message],
          },
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, updatedAt: new Date() } : c
          ),
        }));

        // Save to offline storage
        await offlineStorage.saveMessage(message);

        // Try to persist to database
        try {
          await fetch(`/api/conversations/${conversationId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              role: message.role,
              content: message.content,
              model: message.model,
              parentId: message.parentId,
            }),
          });
        } catch (error) {
          console.error('Failed to persist message:', error);
          // Add to sync queue for later
          await offlineStorage.addToSyncQueue({
            type: 'create_message',
            data: {
              conversationId,
              role: message.role,
              content: message.content,
              model: message.model,
              parentId: message.parentId,
            },
          });
        }
      },

      updateMessage: (conversationId, messageId, content) => {
        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: (state.messages[conversationId] || []).map((m) =>
              m.id === messageId ? { ...m, content, updatedAt: new Date() } : m
            ),
          },
        }));
      },

      deleteMessage: (conversationId, messageId) => {
        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: (state.messages[conversationId] || []).filter(
              (m) => m.id !== messageId
            ),
          },
        }));
      },

      getMessages: (conversationId) => {
        return get().messages[conversationId] || [];
      },

      getCurrentConversation: () => {
        const state = get();
        return state.conversations.find((c) => c.id === state.currentConversationId) || null;
      },

      clearConversationMessages: (conversationId: string) => {
        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: [],
          },
        }));
      },

      syncConversations: async () => {
        set({ isSyncing: true });
        try {
          // Process offline sync queue first
          if (syncService.isOnline()) {
            await syncService.processSyncQueue();
          }

          const response = await fetch('/api/conversations');
          if (response.ok) {
            const { conversations } = (await response.json()) as {
              conversations: Array<Record<string, unknown>>;
            };
            const serverConversations = conversations.map((c) => migrateConversation(c));

            // Merge strategy: Keep local conversations with temp IDs and merge with server data
            set((state) => {
              const localConversations = state.conversations;
              const conversationMap = new Map<string, Conversation>();

              // Note: We use recentlyDeletedIds to track deleted conversations

              // First, add all server conversations
              for (const conv of serverConversations) {
                // Skip if this conversation was recently deleted locally
                if (!state.recentlyDeletedIds.has(conv.id)) {
                  conversationMap.set(conv.id, conv);
                }
              }

              // Then, preserve local conversations that aren't on the server yet
              for (const conv of localConversations) {
                // Keep conversations with temporary IDs (not synced yet)
                if (conv.id.startsWith('temp-') && !conversationMap.has(conv.id)) {
                  conversationMap.set(conv.id, conv);
                }
                // Also keep any local conversation that has messages but isn't on server
                else if (!conversationMap.has(conv.id) && state.messages[conv.id]?.length > 0) {
                  conversationMap.set(conv.id, conv);
                }
              }

              // Convert map back to sorted array (newest first)
              const mergedConversations = Array.from(conversationMap.values()).sort(
                (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
              );

              return {
                conversations: mergedConversations,
                isSyncing: false,
              };
            });

            // Update offline storage with server data only
            for (const conv of serverConversations) {
              await offlineStorage.saveConversation(conv);
            }
          } else {
            // Don't overwrite local data on server error
            console.error('Server returned error:', response.status);
            set({ isSyncing: false });
          }
        } catch (error) {
          console.error('Failed to sync conversations:', error);
          // Don't overwrite local data on network error
          set({ isSyncing: false });
        }
      },

      syncMessages: async (conversationId: string) => {
        try {
          const response = await fetch(`/api/conversations/${conversationId}/messages`);
          if (response.ok) {
            const { messages } = (await response.json()) as {
              messages: Array<Record<string, unknown>>;
            };

            // Ensure we have valid data
            if (!Array.isArray(messages)) {
              console.error('Invalid messages response - not an array');
              return;
            }

            // Migrate messages from D1 format to client format
            const serverMessages = messages.map((m, index) => {
              try {
                // Validate message object
                if (!m || typeof m !== 'object') {
                  throw new Error('Invalid message object');
                }

                return migrateMessage({
                  id: (m.id as string) || `temp-${conversationId}-${index}`,
                  conversationId: (m.conversationId as string) || conversationId,
                  role: (m.role as 'user' | 'assistant' | 'system') || 'user',
                  content: (m.content as string) || '',
                  model: m.model as string | undefined,
                  parentId: m.parentId as string | null | undefined,
                  isComplete: m.isComplete !== undefined ? (m.isComplete as boolean) : true,
                  streamState: m.streamState as string | null | undefined,
                  tokensGenerated:
                    m.tokensGenerated !== undefined ? (m.tokensGenerated as number) : 0,
                  totalTokens: m.totalTokens as number | null | undefined,
                  streamId: m.streamId as string | null | undefined,
                  createdAt: m.createdAt as string | Date,
                });
              } catch (error) {
                console.error('Failed to migrate message:', m, error);
                // Fallback to basic migration if advanced migration fails
                return {
                  id: (m.id as string) || `fallback-${Date.now()}-${index}`,
                  conversationId: (m.conversationId as string) || conversationId,
                  role: (m.role as 'user' | 'assistant' | 'system') || 'user',
                  content: (m.content as string) || '',
                  model: (m.model as string) || undefined,
                  parentId: (m.parentId as string) || undefined,
                  createdAt: m.createdAt ? new Date(m.createdAt as string) : new Date(),
                  attachments: [],
                } as Message;
              }
            });

            // Merge strategy for messages with deduplication
            set((state) => {
              const localMessages = state.messages[conversationId] || [];
              const messageMap = new Map<string, Message>();
              const contentTimeMap = new Map<string, Message>();

              // Create a key for deduplication based on content, role, and approximate time
              const getDedupeKey = (msg: Message) => {
                const timeWindow = Math.floor(msg.createdAt.getTime() / 5000) * 5000; // 5-second window
                return `${msg.role}|${msg.content}|${timeWindow}`;
              };

              // Add server messages first (they take precedence)
              for (const msg of serverMessages) {
                messageMap.set(msg.id, msg);
                contentTimeMap.set(getDedupeKey(msg), msg);
              }

              // Only add local messages that don't duplicate server messages
              for (const msg of localMessages) {
                const dedupeKey = getDedupeKey(msg);
                const existingMsg = contentTimeMap.get(dedupeKey);

                // Skip if we already have this message from server
                if (existingMsg && !msg.id.startsWith('temp-')) {
                  continue;
                }

                // Keep temp messages that aren't duplicates
                if (msg.id.startsWith('temp-') && !existingMsg) {
                  messageMap.set(msg.id, msg);
                  contentTimeMap.set(dedupeKey, msg);
                }
              }

              // Convert back to array sorted by creation time
              const mergedMessages = Array.from(messageMap.values()).sort(
                (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
              );

              return {
                messages: {
                  ...state.messages,
                  [conversationId]: mergedMessages,
                },
              };
            });

            // Update offline storage with server data
            await offlineStorage.saveMessages(serverMessages);
          } else {
            console.error('Server returned error for messages:', response.status);
            // Don't overwrite local messages on error
          }
        } catch (error) {
          console.error('Failed to sync messages:', error);
          // Don't overwrite local messages on network error
        }
      },
    }),
    {
      name: 'conversation-storage',
      partialize: (state) => ({
        ...state,
        recentlyDeletedIds: Array.from(state.recentlyDeletedIds), // Convert Set to Array for persistence
      }),
      onRehydrateStorage: () => (state) => {
        if (
          state &&
          Array.isArray(
            (state as ConversationState & { recentlyDeletedIds: string[] }).recentlyDeletedIds
          )
        ) {
          // Convert Array back to Set after rehydration
          state.recentlyDeletedIds = new Set(
            (state as ConversationState & { recentlyDeletedIds: string[] }).recentlyDeletedIds
          );
        }
      },
    }
  )
);
