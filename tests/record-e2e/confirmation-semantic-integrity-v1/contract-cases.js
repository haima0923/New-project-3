const CASES = [
  { id: 'CSI-001', category: 'DRAFT_TO_CARD', scenario: 'draft_order', baselineStatus: 'PASS' },
  { id: 'CSI-002', category: 'DRAFT_TO_CARD', scenario: 'draft_quotation_multi', baselineStatus: 'PASS' },
  { id: 'CSI-003', category: 'DRAFT_TO_CARD', scenario: 'draft_receivable', baselineStatus: 'PASS' },
  { id: 'CSI-004', category: 'DRAFT_TO_CARD', scenario: 'draft_payment', baselineStatus: 'PASS' },
  { id: 'CSI-005', category: 'DRAFT_TO_CARD', scenario: 'draft_dunning', baselineStatus: 'PASS' },

  { id: 'CSI-006', category: 'EDIT_TO_SAVE', scenario: 'edit_order_all', baselineStatus: 'PASS' },
  { id: 'CSI-007', category: 'EDIT_TO_SAVE', scenario: 'edit_receivable', baselineStatus: 'PASS' },
  { id: 'CSI-008', category: 'EDIT_TO_SAVE', scenario: 'edit_payment', baselineStatus: 'PASS' },
  { id: 'CSI-009', category: 'EDIT_TO_SAVE', scenario: 'edit_todo', baselineStatus: 'PASS' },

  { id: 'CSI-010', category: 'STALE_STATE', scenario: 'stale_order_root', baselineStatus: 'PASS' },
  { id: 'CSI-011', category: 'STALE_STATE', scenario: 'stale_order_item', baselineStatus: 'PASS' },
  { id: 'CSI-012', category: 'STALE_STATE', scenario: 'stale_payment', baselineStatus: 'PASS' },

  { id: 'CSI-013', category: 'TYPE_SWITCH', scenario: 'switch_quotation_order', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'TYPE_SWITCH_RESIDUE', code: 'QO.FOLLOWUP_DAYS_CLEARED' } },
  { id: 'CSI-014', category: 'TYPE_SWITCH', scenario: 'switch_order_quotation', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'DATE_SYNC', code: 'OQ.DELIVERY_NOT_REUSED' } },
  { id: 'CSI-015', category: 'TYPE_SWITCH', scenario: 'switch_order_receivable', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'HIDDEN_FIELD_LEAK', code: 'OR.ITEMS_CLEARED' } },
  { id: 'CSI-016', category: 'TYPE_SWITCH', scenario: 'switch_receivable_payment', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'AMOUNT_SYNC', code: 'RP.RECEIVABLE_AMOUNT_NOT_REUSED' } },
  { id: 'CSI-017', category: 'TYPE_SWITCH', scenario: 'switch_todo_dunning', baselineStatus: 'PASS' },
  { id: 'CSI-018', category: 'TYPE_SWITCH', scenario: 'switch_dunning_todo', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'TYPE_SWITCH_RESIDUE', code: 'DT.TODO_TYPE_CLEARED' } },
  { id: 'CSI-019', category: 'TYPE_SWITCH', scenario: 'formal_to_pending', baselineStatus: 'PASS' },

  { id: 'CSI-020', category: 'HIDDEN_FIELD', scenario: 'hidden_relation_payment_todo', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'RELATION_LEAK', code: 'HIDDEN.RECEIVABLE_CLEARED' } },
  { id: 'CSI-021', category: 'MULTI_ITEM', scenario: 'multi_edit_isolation', baselineStatus: 'PASS' },
  { id: 'CSI-022', category: 'MULTI_ITEM', scenario: 'multi_remove_add', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'ITEM_SYNC', code: 'ADD.REMOVED_ITEM_RISK_CLEARED' } },
  { id: 'CSI-023', category: 'FLATTENED_ITEM', scenario: 'flattened_conflict', baselineStatus: 'PASS' },
  { id: 'CSI-024', category: 'AMOUNT', scenario: 'amount_semantics', baselineStatus: 'PASS' },
  { id: 'CSI-025', category: 'DATE', scenario: 'date_semantics', baselineStatus: 'PASS' },
  { id: 'CSI-026', category: 'RELATION', scenario: 'relation_integrity', baselineStatus: 'PASS' },
  { id: 'CSI-027', category: 'ORIGINAL_TEXT', scenario: 'original_formal', baselineStatus: 'PASS' },
  { id: 'CSI-028', category: 'ORIGINAL_TEXT', scenario: 'original_pending', baselineStatus: 'PASS' },

  { id: 'CSI-029', category: 'SPEC', scenario: 'spec_sparse_quotation', baselineStatus: 'SPEC_REQUIRED' },
  { id: 'CSI-030', category: 'SPEC', scenario: 'spec_sparse_order', baselineStatus: 'SPEC_REQUIRED' },
  { id: 'CSI-031', category: 'SPEC', scenario: 'spec_dunning_required', baselineStatus: 'SPEC_REQUIRED' },

  { id: 'CSI-032', category: 'AMOUNT', scenario: 'deposit_alias_edit', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'AMOUNT_SYNC', code: 'DEPOSIT.CANONICAL_ALIAS' } },
  { id: 'CSI-033', category: 'AMOUNT', scenario: 'quotation_root_total', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'DISPLAY_MAPPING', code: 'QUOTE_TOTAL.CONTROL_VISIBLE' } },
  { id: 'CSI-034', category: 'MULTI_ITEM', scenario: 'item_meta_editability', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'DISPLAY_MAPPING', code: 'ITEM_META.DELIVERY_EDITABLE' } },
  { id: 'CSI-035', category: 'HIDDEN_FIELD', scenario: 'hidden_quotation_fields', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'HIDDEN_FIELD_LEAK', code: 'HIDDEN_QUOTE.VALID_UNTIL' } },
  { id: 'CSI-036', category: 'DATE', scenario: 'date_quotation', baselineStatus: 'PASS' },
  { id: 'CSI-037', category: 'DATE', scenario: 'date_receivable', baselineStatus: 'PASS' },
  { id: 'CSI-038', category: 'DATE', scenario: 'date_payment', baselineStatus: 'PASS' },
  { id: 'CSI-039', category: 'DATE', scenario: 'date_todo', baselineStatus: 'PASS' },
  { id: 'CSI-040', category: 'AMOUNT', scenario: 'payment_remaining_amount', baselineStatus: 'PASS' },
  { id: 'CSI-041', category: 'RELATION', scenario: 'quotation_relation_integrity', baselineStatus: 'PASS' },
  { id: 'CSI-042', category: 'RELATION', scenario: 'order_relation_switch', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'TYPE_SWITCH_RESIDUE', code: 'ORDER_REL.CREATE_NOT_UPDATE' } },

  { id: 'CSI-043', category: 'HIDDEN_FIELD', scenario: 'explicit_hidden_valid_until', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'HIDDEN_FIELD_LEAK', code: 'HIDDEN_QUOTE.EXPLICIT_VALID_UNTIL_PROJECTED' } },
  { id: 'CSI-044', category: 'HIDDEN_FIELD', scenario: 'explicit_hidden_payment_method', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'HIDDEN_FIELD_LEAK', code: 'HIDDEN_QUOTE.EXPLICIT_PAYMENT_METHOD_PROJECTED' } },
  { id: 'CSI-045', category: 'HIDDEN_FIELD', scenario: 'quotation_authority_positive', baselineStatus: 'PASS' },

  { id: 'CSI-046', category: 'AMOUNT', scenario: 'deposit_standalone_alias_edit', baselineStatus: 'EXPECTED_RED', baselineFirstFailure: { taxonomy: 'AMOUNT_SYNC', code: 'DEPOSIT_STANDALONE.CARD_CANONICAL' } },
  { id: 'CSI-047', category: 'AMOUNT', scenario: 'deposit_standalone_unedited', baselineStatus: 'PASS' },
  { id: 'CSI-048', category: 'AMOUNT', scenario: 'deposit_unknown_amount', baselineStatus: 'PASS' }
];

module.exports = { CASES };
