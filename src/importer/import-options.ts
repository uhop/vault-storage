import type {DatabaseSync} from 'node:sqlite';
import {QueueItemsRepository} from '../queue/repo.ts';
import {SuggestionFiler} from './file-suggestions.ts';
import type {ImportFileOptions} from './import-file.ts';
import {TagsImporter} from './import-tags.ts';

/**
 * Every derivative an import keeps current. `Required` makes a new option a
 * type error here instead of a call site that silently skips it.
 */
export const fullImportOptions = (db: DatabaseSync): Required<ImportFileOptions> => ({
  tags: new TagsImporter(db),
  agentStale: new SuggestionFiler(db, 'agent_enrichment_stale'),
  tagSuggestion: new SuggestionFiler(db, 'tag_suggestion'),
  archiveCandidate: new SuggestionFiler(db, 'archive_candidate'),
  queueItems: new QueueItemsRepository(db)
});
