# API Contract Draft

MVP 当前使用本地存储和本地规则解析器。后端接入时，应保持“AI 只生成草稿，用户确认后保存正式数据”的边界。

## Parse Input

`POST /api/ai/parse`

Request:

```json
{
  "text": "给王总报1000个卡通水杯，5块5一个，月底交",
  "source": "typed",
  "context": "home",
  "customerCandidates": [
    {
      "id": "cus_1",
      "name": "王总",
      "company": "义乌饰品厂",
      "region": "义乌",
      "lastTradeAt": "2026-06-16"
    }
  ]
}
```

Response:

```json
{
  "intent": "quotation",
  "fields": {
    "customerName": "王总",
    "phone": "",
    "productName": "卡通水杯",
    "spec": "",
    "quantity": "1000",
    "unit": "个",
    "unitPrice": "5.5",
    "amount": "5500",
    "depositAmount": "",
    "paymentAmount": "",
    "paymentKind": "",
    "paymentMethod": "",
    "dueDate": "2026-06-30",
    "remark": "给王总报1000个卡通水杯，5块5一个，月底交"
  },
  "missing_fields": [],
  "low_confidence_fields": [],
  "customer_candidates": [],
  "computed_fields": ["amount"],
  "field_sources": {
    "customerName": "rule:customer_title",
    "productName": "rule:known_product",
    "quantity": "rule:quantity_unit",
    "unitPrice": "rule:bare_unit_price",
    "amount": "rule:quantity_times_unit_price",
    "dueDate": "rule:date_phrase"
  },
  "intent_candidates": ["order", "quotation"],
  "confidence": 0.91,
  "confirm_message": "我识别成下面这样，你确认后再保存。"
}
```

Rules:

- `intent` must be one of `quotation`, `order`, `receivable`, `payment`, `dunning`, `query`, `unknown`.
- `computed_fields` marks values calculated by the system, such as `amount = quantity * unitPrice`.
- `field_sources` identifies where each field came from, such as local rules or AI.
- `intent_candidates` should list plausible business types when the utterance is ambiguous.
- Deposit input must use `paymentKind: "deposit"` and fill `depositAmount` plus `paymentAmount`; it belongs to an order, not a receivable.
- Low confidence customer matches must return candidate customers instead of auto-merging.
- Missing or low confidence critical fields must prevent direct formal save.
- Raw input and parse result should be persisted in `ai_parse_log`.

## Save Confirmed Draft

`POST /api/records/confirm`

Request:

```json
{
  "parseLogId": "log_1",
  "intent": "quotation",
  "fields": {
    "customerName": "王总",
    "phone": "",
    "productName": "卡通水杯",
    "quantity": "1000",
    "unit": "个",
    "unitPrice": "5.5",
    "amount": "5500",
    "dueDate": "2026-06-30"
  }
}
```

Response:

```json
{
  "type": "quotation",
  "id": "quo_1"
}
```

Rules:

- Server must re-check required fields before formal save.
- If required fields are still missing, save as `pending_note`.
- Customer can be created without phone.
- If phone exists, use `user_id + phone_fingerprint` to de-duplicate.

## Query

`POST /api/ai/query`

Request:

```json
{
  "question": "王总上次报多少？"
}
```

Response:

```json
{
  "title": "王总 上次报价",
  "lines": [
    "卡通水杯，数量 1000个",
    "单价 5.5，总价 5500",
    "报价日期 2026-06-16，状态 待确认"
  ],
  "readonly": true
}
```

Rules:

- Query responses are read-only.
- Query must never mutate quotation, order, receivable, customer, or pending note records.

## Voice Transcription

`POST /api/ai/transcribe`

Request:

```json
{
  "fileId": "uploaded_voice_file_id",
  "durationMs": 8500,
  "format": "mp3"
}
```

Response:

```json
{
  "text": "李总欠五万，这个月月底结",
  "confidence": 0.87
}
```

Rules:

- Transcription should feed into `/api/ai/parse`.
- If transcription confidence is low, the client must show editable text before parse confirmation.
