import type { ErrorResponse, Page } from './index';

export type CompletionWalletOverride =
  | { instrument: 'pass'; passId: string; sessions: number }
  | { instrument: 'prepaid'; amount: number }
  | { instrument: 'skipped' };

export interface CompletionPreviewRequest {
  cardVersion: number;
  customerVersion: number;
  customerName?: string;
  customerPhone?: string | null;
  walletOverride?: CompletionWalletOverride;
}

export interface CompletionResolveRequest extends CompletionPreviewRequest {
  action: 'approve';
  completionStep: 'all';
}

export interface CompletionDeduction {
  instrument: 'pass' | 'prepaid' | 'skipped';
  quantity: number;
  passId?: string;
}

export interface CompletionPlan extends CompletionDeduction {
  rank: 1 | 2 | 3;
  needsChoice?: true;
}

export interface CompletionActionWarning {
  code: string;
  projectedBalance?: number;
}

export interface CompletionAction {
  id: string;
  kind: 'completion_cycle';
  status: 'pending';
  appointmentId: string;
  customerId: string;
  cardVersion: number;
  customerVersion: number;
  priorityRank: number;
  appointmentStartAt: string;
  customerName: string;
  menuName: string | null;
  deduction: CompletionPlan;
  warnings: CompletionActionWarning[];
}

export type CompletionActionPage = Page<CompletionAction>;

export interface CompletionPreview {
  renderedPreview: string;
  templateId: string | null;
  templateSlot: 'post_session' | 'post_amount' | 'post_general' | 'custom';
  byteLength: number;
  messageType: 'SMS' | 'LMS' | null;
  valid: boolean;
  missingVariables: string[];
  deduction?: CompletionPlan;
  warnings: CompletionActionWarning[];
  cardVersion: number;
  customerVersion: number;
}

export type CompletionResolveResult =
  | {
      outcome: 'resolved';
      cardStatus: 'resolved';
      cardVersion: number;
      appointmentStatus: 'completed';
      deduction: CompletionDeduction & { prepaidBalance: number | null; remainingSessions: number | null };
      message: {
        status: 'queued' | 'already_queued' | 'needs_input' | 'skipped';
        reason?: string;
        followUpCardId?: string;
      };
    }
  | { outcome: 'failed'; reason: 'TARGET_CHANGED'; cardStatus: 'failed'; cardVersion: number }
  | {
      outcome: 'needs_input';
      cardStatus: 'pending';
      cardVersion: number;
      choiceCard: { id: string; kind: 'choice'; category: 'merge_customers' };
    };

export type CompletionConflict =
  | (ErrorResponse<'COMPLETION_PREVIEW_REQUIRED'> & { details: { reason: 'INSTRUMENT_CHANGED' | 'AMOUNT_CHANGED' } })
  | ErrorResponse<'VERSION_CONFLICT' | 'INVALID_TRANSITION'>;
