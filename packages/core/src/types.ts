/**
 * StudyOS core domain types.
 *
 * Design rule that shapes this whole file: the system must never confuse
 * "time spent" with "learning achieved", and must never present an estimate
 * as a measurement. Every quantity that reaches a user carries a Provenance.
 */

/** Where a number came from. Displayed to the user; never silently upgraded. */
export type Provenance =
  /** Recorded by a timer, OS API or extension. Trustworthy to the second. */
  | 'measured'
  /** Derived by a rule or model. May be wrong; always labelled in the UI. */
  | 'inferred'
  /** A human stated it (manual session entry, reflection, correction). */
  | 'confirmed'
  /** Demonstrated by graded performance (practice, recall, assessment). */
  | 'demonstrated';

export interface Provenanced<T> {
  value: T;
  provenance: Provenance;
  /** Short human-readable justification, shown on hover/expand. */
  reason?: string;
}

export type ActivityCategory =
  | 'deep_study'
  | 'revision'
  | 'practice'
  | 'research'
  | 'reading'
  | 'writing'
  | 'programming'
  | 'project'
  | 'admin'
  | 'break'
  | 'distraction'
  | 'unclassified'
  /** User-defined categories are stored as `custom:<slug>`. */
  | `custom:${string}`;

/** Categories that count toward productive study totals. */
export const PRODUCTIVE_CATEGORIES: ReadonlySet<string> = new Set<string>([
  'deep_study', 'revision', 'practice', 'research', 'reading', 'writing', 'programming', 'project',
]);

export interface ActivityEvent {
  /** Immutable, device-generated id. Used for idempotent sync. */
  id: string;
  deviceId: string;
  /** Epoch ms, inclusive. */
  startedAt: number;
  /** Epoch ms, exclusive. */
  endedAt: number;
  /**
   * Milliseconds of actual interaction inside the window. Always <= the
   * window length. Idle gaps and device sleep are excluded here, not from
   * `endedAt`, so elapsed and active time stay separately auditable.
   */
  activeMs: number;
  category: ActivityCategory;
  provenance: Provenance;
  subjectId?: string;
  topicId?: string;
  taskId?: string;
  /** Set when the user edited or reclassified a synced event. */
  correctedAt?: number;
  note?: string;
}

export type ReviewGrade = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

export interface RevisionState {
  /** FSRS memory stability, in days. */
  stability: number;
  /** FSRS difficulty, 1..10. */
  difficulty: number;
  /** Epoch ms of the last review, or undefined if never reviewed. */
  lastReviewedAt?: number;
  /** Epoch ms when the card next falls due. */
  dueAt: number;
  reps: number;
  lapses: number;
}

export type MasteryState =
  | 'not_started'
  | 'learning'
  | 'practising'
  | 'needs_revision'
  | 'strong'
  | 'mastered';

export interface PracticeAttempt {
  id: string;
  topicId: string;
  attemptedAt: number;
  correct: boolean;
  /** Optional partial credit in [0,1] for rubric-marked answers. */
  score?: number;
  errorCategory?: string;
}

export interface Task {
  id: string;
  title: string;
  subjectId?: string;
  topicId?: string;
  /** Minutes the user or planner expects this to take. */
  estimateMin: number;
  /** Minutes actually recorded against it. */
  actualMin?: number;
  dueAt?: number;
  priority: 1 | 2 | 3 | 4; // 1 = highest
  dependsOn?: string[];
  completedAt?: number;
  workspaceId?: string;
}

/** A window of time the user is actually available to work. */
export interface AvailabilityBlock {
  startsAt: number;
  endsAt: number;
  /** Fixed commitments (lessons, meetings) are unavailable, not negotiable. */
  fixed?: boolean;
  label?: string;
}

export interface Exam {
  id: string;
  subjectId: string;
  title: string;
  startsAt: number;
  /** e.g. "Paper 1". Curriculum-specific; validated by the curriculum preset. */
  component?: string;
}
