export { TaskStore } from './TaskStore.js';
export { openDatabase } from './db.js';
export type { DatabaseType } from './db.js';
export { runMigrations, MIGRATIONS } from './migrations.js';
export type { Migration } from './migrations.js';
export { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
export * from './types.js';
export {
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  buildContext,
  buildContextWithEmbeddingRanking,
  cosineSimilarity,
} from './ContextBuilder.js';
export type {
  ContextPackage,
  ContextFileRef,
  ContextCommitRef,
  BuildContextOptions,
  EmbeddingProvider,
  BuildContextWithEmbeddingRankingOptions,
} from './ContextBuilder.js';
export {
  DEFAULT_FILE_TRIGGER_THRESHOLD,
  DEFAULT_IDLE_TRIGGER_MINUTES,
  summarizeFileBatch,
  summarizeCommit,
  summarizeError,
  summarizeIdle,
  maybeCheckpointOnFileActivity,
  checkpointOnCommit,
  checkpointOnError,
  maybeCheckpointOnIdle,
  rollupCheckpoints,
  setTaskStatusWithRollup,
  ruleBasedSummarizer,
  maybeCheckpointOnFileActivityWithSummarizer,
  checkpointOnCommitWithSummarizer,
  checkpointOnErrorWithSummarizer,
  maybeCheckpointOnIdleWithSummarizer,
} from './CheckpointEngine.js';
export type { CheckpointSummarizer } from './CheckpointEngine.js';
export {
  getHeadSha,
  getCurrentBranch,
  listRecentCommits,
  listCommitFiles,
  fileRoleFromGitStatus,
  isGitCommitCommand,
  syncTaskGit,
} from './GitWatcher.js';
export type { GitLogEntry, GitCommitFileEntry, SyncGitResult, GitCaptureFailure } from './GitWatcher.js';
export {
  captureTaskFiles,
  isAlwaysExcludedCapturePath,
  DEFAULT_CAPTURE_LIMITS,
  GitCaptureCommandError,
} from './FileCapture.js';
export {
  TaskFileCaptureFailureError,
  TaskFileCaptureFailureRecordingError,
  TaskFileCaptureFailureAggregateError,
  throwSanitizedTaskFileCaptureFailure,
} from './TaskFileCaptureFailure.js';
export type { TaskFileCaptureFailureContext } from './TaskFileCaptureFailure.js';
export type {
  CaptureLimits,
  CaptureRequest,
  CaptureResult,
  CaptureSkip,
  CaptureSkipReason,
} from './FileCapture.js';
export {
  DEFAULT_REDACTION_RULES,
  MAX_REDACTED_LENGTH,
  OUTPUT_TAIL_MAX_LINES,
  OUTPUT_TAIL_MAX_CHARS,
  redact,
  redactCommand,
  redactLines,
  summarizeOutputTail,
} from './Redactor.js';
export type { RedactionRule } from './Redactor.js';
export { exportTaskMarkdown } from './Exporter.js';
export { ensureGitignored } from './gitignore.js';
export { searchWorkspace } from './Search.js';
export type { SearchCategory, SearchMatch, SearchResult, SearchOptions } from './Search.js';
export {
  buildKnowledgeSearchContext,
  lexicalScore,
  searchKnowledge,
} from './knowledge/KnowledgeSearch.js';
export {
  hashDeterministicExtraction,
  offsetToPosition,
  stableExtractionStringify,
  validateDeterministicExtraction,
} from './knowledge/KnowledgeExtraction.js';
export type {
  DeterministicExtraction,
  ExtractedMetadata,
  ExtractedMetadataValue,
  ExtractedLink,
  ExtractedRelationship,
  ExtractedRelationshipType,
  ExtractedSection,
  ExtractedSymbol,
  ExtractedSymbolKind,
  ExtractionDiagnostic,
  ExtractionDiagnosticSeverity,
  KnowledgeSourcePosition,
  KnowledgeSourceSpan,
} from './knowledge/KnowledgeExtraction.js';
export { KnowledgeExtractionStore } from './knowledge/KnowledgeExtractionStore.js';
export {
  AnalyzerRegistry,
  createDefaultAnalyzerRegistry,
  JavaScriptAnalyzer,
  MarkdownAnalyzer,
  PythonAnalyzer,
  TextAnalyzer,
} from './knowledge/analyzers/index.js';
export type { AnalyzerInput, AnalyzerSelectionInput, DeterministicAnalyzer } from './knowledge/analyzers/index.js';
export type {
  KnowledgeExtractionRecord,
  KnowledgeExtractionSectionRecord,
  PersistedKnowledgeSourceSpan,
  SaveKnowledgeExtractionInput,
} from './knowledge/KnowledgeExtractionStore.js';
export type {
  KnowledgeSearchCitation,
  KnowledgeSearchContext,
  KnowledgeSearchContextOptions,
  KnowledgeSearchGraphExpansion,
  KnowledgeSearchMode,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeSearchResultKind,
} from './knowledge/KnowledgeSearch.js';
export {
  discoverKnowledgeSkills,
  KnowledgeSkillRegistry,
} from './knowledge/KnowledgeSkills.js';
export type {
  KnowledgeSkill,
  KnowledgeSkillDiscovery,
  KnowledgeSkillDiscoveryError,
  KnowledgeSkillDiscoveryOptions,
  KnowledgeSkillInput,
  KnowledgeSkillInputRequest,
  KnowledgeSkillRegistryOptions,
  KnowledgeSkillScope,
  SelectedKnowledgeSkill,
} from './knowledge/KnowledgeSkills.js';
export { KnowledgeOutputStore } from './knowledge/KnowledgeOutputs.js';
export type {
  CreateKnowledgeOutputInput,
  KnowledgeOutput,
  KnowledgeOutputOverwritePolicy,
  KnowledgeOutputPreview,
  KnowledgeOutputStoreOptions,
} from './knowledge/KnowledgeOutputs.js';
export {
  findWorkspaceRoot,
  stateDbPath,
  openWorkspaceStore,
  openWorkspaceStoreReadOnly,
  readCurrentTaskId,
  setCurrentTaskId,
} from './workspace.js';
export {
  getRegistryPath,
  openRegistry,
  closeRegistry,
  touchWorkspace,
  upsertTaskIndex,
  syncWorkspaceTasks,
  listWorkspaces,
  listAllTasks,
  findTaskWorkspace,
  forgetWorkspace,
  pruneMissingWorkspaces,
} from './Registry.js';
export type { TaskIndexEntry } from './Registry.js';
export {
  listTasksAcrossWorkspaces,
  listKnownWorkspaces,
  searchAcrossWorkspaces,
  resolveTaskAnyWorkspace,
} from './CrossWorkspace.js';
export type {
  CrossWorkspaceTask,
  CrossWorkspaceSearchResult,
  CrossWorkspaceSearchOptions,
  ResolvedTask,
} from './CrossWorkspace.js';
export {
  createTaskLinkGroup,
  getTaskLinkGroup,
  listTaskLinkGroups,
  linkTaskToGroup,
  unlinkTaskFromGroup,
  listGroupMembers,
  findGroupsForTask,
  deleteTaskLinkGroup,
} from './CrossRepoLinks.js';
export type { TaskLinkGroup, TaskLinkMember } from './CrossRepoLinks.js';
export {
  GRAPHIFY_INSTALL_HINT,
  isGraphifyInstalled,
  runGraphify,
  runGraphifySync,
  summarizeGraphifyRun,
} from './Graphify.js';
export type { GraphifyResult, RunGraphifyOptions, GraphifySpawnFn } from './Graphify.js';
export { PluginRegistry } from './PluginRegistry.js';
export type {
  AriadnePlugin,
  AriadnePluginContext,
  AriadnePluginEvents,
  AriadneEventName,
  PluginHooks,
} from './PluginRegistry.js';
export { createKnowledgeId, normalizeKnowledgePath } from './knowledge/KnowledgeIds.js';
export { KnowledgeProjectStore } from './knowledge/KnowledgeProjectStore.js';
export type {
  CreateKnowledgeProjectInput,
  KnowledgeProject,
  KnowledgeProjectStatus,
  ListKnowledgeProjectsOptions,
  UpdateKnowledgeProjectInput,
} from './knowledge/KnowledgeProjectStore.js';
export { KnowledgeSourceStore, registerKnowledgeSource } from './knowledge/KnowledgeSourceStore.js';
export type {
  RegisterKnowledgeSourceInput,
  KnowledgeSourceVersionRecord,
} from './knowledge/KnowledgeSourceStore.js';
export {
  KnowledgeSourceVersionLoadError,
  loadKnowledgeSourceVersion,
} from './knowledge/KnowledgeSourceVersionLoader.js';
export type { LoadedKnowledgeSourceVersion } from './knowledge/KnowledgeSourceVersionLoader.js';
export { scanKnowledgeSources } from './knowledge/KnowledgeSourceScanner.js';
export type { SourceCandidate } from './knowledge/KnowledgeSourceScanner.js';
export { shouldIngestSource } from './knowledge/SourcePolicy.js';
export type { SourceDecision, SourceDecisionAction, SourceDecisionReason, SourcePolicy } from './knowledge/SourcePolicy.js';
export { KnowledgeReconciliation, reconcileChangedSource, reconcileDeletedSource } from './knowledge/KnowledgeReconciliation.js';
export type {
  KnowledgeReconciliationOptions,
  ReconciliationRunOptions,
  SourceReconciliationResult,
} from './knowledge/KnowledgeReconciliation.js';
export {
  KNOWLEDGE_MANIFEST_VERSION,
  buildKnowledgeManifest,
  readKnowledgeManifest,
  writeKnowledgeManifest,
} from './knowledge/KnowledgeManifest.js';
export type { KnowledgeManifest } from './knowledge/KnowledgeManifest.js';
export {
  KnowledgePageStore,
  createPageVersion,
  getCurrentPage,
  listPages,
  supersedePageVersion,
  markPageStale,
} from './knowledge/KnowledgePageStore.js';
export type {
  CreatePageVersionInput,
  KnowledgePage,
  KnowledgePageVersion,
  SupersedePageVersionInput,
} from './knowledge/KnowledgePageStore.js';
export {
  KnowledgeRenderer,
  renderKnowledgePage,
  renderKnowledgeIndex,
  renderKnowledgeOverview,
  renderKnowledgeLog,
} from './knowledge/KnowledgeRenderer.js';
export type {
  KnowledgePageRenderInput,
  KnowledgeIndexEntry,
} from './knowledge/KnowledgeRenderer.js';
export {
  buildDeterministicPagePayload,
} from './knowledge/DeterministicPageBuilder.js';
export type {
  DeterministicPageBuildInput,
} from './knowledge/DeterministicPageBuilder.js';
export {
  KnowledgeGeneratorService,
  runKnowledgeGeneration,
} from './knowledge/KnowledgeGeneratorService.js';
export type {
  KnowledgeGenerationPageInput,
  KnowledgeGenerationPageResult,
  KnowledgeGenerationPayload,
  KnowledgeGenerationResult,
  KnowledgeGeneratorServiceOptions,
} from './knowledge/KnowledgeGeneratorService.js';
export {
  KnowledgeQueue,
  enqueueKnowledgeJob,
  claimKnowledgeJob,
} from './knowledge/KnowledgeQueue.js';
export type {
  EnqueueKnowledgeJobInput,
  KnowledgeJobRecord,
  KnowledgeJobResult,
  KnowledgeQueueStatus,
  KnowledgeProgressEvent,
  KnowledgeQueueOptions,
} from './knowledge/KnowledgeQueue.js';
export { KnowledgeProvenance } from './knowledge/KnowledgeProvenance.js';
export type { RecordKnowledgeProvenanceInput } from './knowledge/KnowledgeProvenance.js';
export { KnowledgeOperationLog } from './knowledge/KnowledgeOperationLog.js';
export type {
  AppendKnowledgeOperationInput,
  KnowledgeOperationEvent,
  KnowledgeOperationStatus,
  ListKnowledgeOperationsOptions,
} from './knowledge/KnowledgeOperationLog.js';
export {
  KNOWLEDGE_REVIEW_ACTIONS,
  createKnowledgeReview,
  listKnowledgeReviews,
  resolveKnowledgeReview,
  reopenKnowledgeReview,
  bulkResolveKnowledgeReviews,
} from './knowledge/KnowledgeReview.js';
export type {
  BulkResolveKnowledgeReviewsResult,
  CreateKnowledgeReviewInput,
  KnowledgeReviewAction,
  KnowledgeReviewEvidence,
  KnowledgeReviewRecord,
  ListKnowledgeReviewsOptions,
  ReopenKnowledgeReviewInput,
  ResolveKnowledgeReviewInput,
} from './knowledge/KnowledgeReview.js';
export type {
  KnowledgeProjectId,
  KnowledgeSourceId,
  KnowledgePageId,
  KnowledgeJobId,
  KnowledgeReviewId,
  KnowledgeGraphNodeId,
  KnowledgePageType,
  KnowledgeSourceKind,
  KnowledgeJobStatus,
  KnowledgeReviewStatus,
  KnowledgeGraphEdgeType,
  KnowledgeEdgeEvidence,
  KnowledgeProvenanceKind,
  KnowledgeProvenanceRef,
  KnowledgePageRecord,
  KnowledgeSourceRecord,
} from './knowledge/KnowledgeTypes.js';
export {
  detectKnowledgeCommunities,
  scoreCommunityCohesion,
  findBridgeNodes,
  persistKnowledgeCommunities,
} from './knowledge/graph/KnowledgeCommunities.js';
export type {
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
  KnowledgeGraphView,
  KnowledgeCommunity,
  KnowledgeBridgeNode,
} from './knowledge/graph/KnowledgeCommunities.js';
export {
  detectKnowledgeInsights,
  findSparseCommunities,
  findOrphanPages,
  findContradictions,
  findStalePages,
  persistKnowledgeInsights,
} from './knowledge/graph/KnowledgeInsights.js';
export type {
  KnowledgeInsight,
  KnowledgeInsightType,
  KnowledgeInsightAction,
} from './knowledge/graph/KnowledgeInsights.js';
export {
  createOrResumeTaskFromKnowledgeInsight,
  getKnowledgeInsight,
  projectTaskKnowledge,
} from './knowledge/TaskKnowledgeProjection.js';
export type {
  CreateOrResumeTaskFromKnowledgeInsightInput,
  CreateOrResumeTaskFromKnowledgeInsightResult,
  KnowledgeInsightRecord,
  ProjectTaskKnowledgeInput,
  TaskKnowledgeProjectionResult,
  TaskKnowledgeProjectionTrigger,
} from './knowledge/TaskKnowledgeProjection.js';
export {
  KnowledgeGraph,
  scoreGraphEdge,
} from './knowledge/graph/KnowledgeGraph.js';
export type {
  KnowledgeGraphNodeRecord,
  KnowledgeGraphEdgeRecord,
  UpsertGraphNodeInput,
  UpsertGraphEdgeInput,
} from './knowledge/graph/KnowledgeGraph.js';
export {
  getGraphNeighborhood,
  findGraphPath,
} from './knowledge/graph/KnowledgeGraphTraversal.js';
export type {
  GraphTraversalOptions,
  KnowledgeGraphNeighborhood,
  KnowledgeGraphPath,
} from './knowledge/graph/KnowledgeGraphTraversal.js';
export {
  KNOWLEDGE_EDGE_EVIDENCE_WEIGHTS,
} from './knowledge/graph/KnowledgeGraphScoring.js';
export {
  CodeIngestor,
  DocumentIngestor,
  MarkdownIngestor,
  MediaIngestor,
  PlainTextIngestor,
  TaskHistoryIngestor,
  documentFormat,
  mediaFormat,
} from './knowledge/formats/index.js';
export type {
  DocumentAdapter,
  DocumentFormat,
  DocumentIngestorOptions,
  ExtractedSource,
  IngestHeading,
  IngestInput,
  IngestLink,
  IngestMediaReference,
  IngestSpan,
  KnowledgeIngestor,
  MediaAdapter,
  MediaFormat,
  MediaIngestorOptions,
  OptionalIngestFailed,
  OptionalIngestResult,
  OptionalIngestUnsupported,
} from './knowledge/formats/index.js';
export {
  KNOWLEDGE_PROVIDER_CAPABILITIES,
  KnowledgeProviderRegistry,
  KnowledgeProviderRequiredError,
  KnowledgeProviderTimeoutError,
  redactKnowledgeProviderPayload,
} from './knowledge/KnowledgeProviders.js';
export type {
  KnowledgeProvider,
  KnowledgeProviderCapability,
  KnowledgeProviderExecutionContext,
  KnowledgeProviderExecutionOptions,
  KnowledgeRedactionHook,
} from './knowledge/KnowledgeProviders.js';
export {
  rankByEmbedding,
} from './knowledge/KnowledgeEmbeddings.js';
export type {
  EmbeddingProvider as KnowledgeEmbeddingProvider,
  EmbeddingCandidate,
  RankedEmbeddingCandidate,
  RankByEmbeddingOptions,
} from './knowledge/KnowledgeEmbeddings.js';
export { KnowledgeGraphMaterializer } from './knowledge/KnowledgeGraphMaterializer.js';
export type { KnowledgeGraphMaterializationResult } from './knowledge/KnowledgeGraphMaterializer.js';
export { importGraphifyJson } from './knowledge/GraphifyImport.js';
export type {
  GraphImportNode,
  GraphImportEdge,
  GraphImportResult,
} from './knowledge/GraphifyImport.js';
export {
  createProviderRequiredGeneration,
  redactKnowledgeAnalysisPayload,
  validateKnowledgeAnalysis,
  validateKnowledgeGeneration,
} from './knowledge/KnowledgeAnalysis.js';
export {
  KNOWLEDGE_ARCHIVE_VERSION,
  exportKnowledgeProject,
  importKnowledgeProject,
} from './knowledge/KnowledgeArchive.js';
export type {
  KnowledgeArchive,
  KnowledgeArchiveEntry,
  KnowledgeArchiveFile,
  KnowledgeArchiveManifest,
  ExportKnowledgeProjectOptions,
  ImportKnowledgeProjectOptions,
  ImportResult,
} from './knowledge/KnowledgeArchive.js';
export type {
  GeneratedKnowledge,
  KnowledgeAnalysis,
  KnowledgeAnalysisInput,
  KnowledgeAnalysisPayloadKind,
  KnowledgeAnalysisRedactionHooks,
  KnowledgeAnalyzer,
  KnowledgeClaim,
  KnowledgeContradiction,
  KnowledgeEntity,
  KnowledgeGeneration,
  KnowledgeGenerationInput,
  KnowledgeGenerator,
  KnowledgeRelationship,
  KnowledgeResearchGap,
  ProviderRequiredKnowledgeGeneration,
} from './knowledge/KnowledgeAnalysis.js';
export {
  KnowledgeChatService,
} from './knowledge/KnowledgeChat.js';
export type {
  CreateKnowledgeConversationInput,
  KnowledgeChatEvent,
  KnowledgeChatMessageRecord,
  KnowledgeChatProvider,
  KnowledgeChatProviderMessage,
  KnowledgeChatProviderRequest,
  KnowledgeChatRole,
  KnowledgeChatServiceOptions,
  KnowledgeConversationRecord,
  ListKnowledgeConversationsOptions,
  ListKnowledgeMessagesOptions,
  RegenerateKnowledgeChatInput,
  SaveKnowledgeChatMessageToPageInput,
  StreamKnowledgeChatInput,
} from './knowledge/KnowledgeChat.js';
export {
  KnowledgeResearchService,
  ResearchConfirmationRequiredError,
  ResearchProviderRequiredError,
  ResearchProviderTimeoutError,
  ResearchRateLimitError,
  ResearchRequestCancelledError,
} from './knowledge/KnowledgeResearch.js';
export type {
  CreateResearchRequestInput,
  KnowledgeResearchServiceOptions,
  ResearchRequest,
  ResearchRequestStatus,
  ResearchRunResult,
  ResearchSynthesisPage,
} from './knowledge/KnowledgeResearch.js';
export type { ResearchProvider, ResearchResult } from './knowledge/research/ResearchProviders.js';
