---
name: jitech-weekly-kakaowork-summary
description: "카카오워크의 최근 일주일 또는 지난주 대화를 전건 열거해 근거 ID와 완전성 대사까지 포함한 주간 요약을 만든다. 일부 검색이나 주제 검색이 아니라 기간 전체 요약 요청에 사용한다."
metadata: { "openclaw": { "emoji": "📋" } }
---

# 카카오워크 주간 전건 요약

승인된 사용자 패키지의 닫힌 기간 전체를 요약한다. `최근 일주일`은 `rolling_7d`,
`지난주`는 Asia/Seoul 기준 `previous_calendar_week`로 해석한다. 임의 날짜 범위로
확장하지 않는다.

## 실행 계약

1. `jitech_kakaowork_period_records`의 `manifest`를 먼저 호출한다.
2. `status=unavailable|error`이면 검색 도구로 우회하지 말고
   `connection.diagnostic`과 확인하지 못한 범위를 답한다.
3. `totals.messages=0`이면 연결 여부, 절대 시작·종료시각, 0건을 함께 답한다.
   freshness가 stale이면 `해당 기간 0건`을 `전건 확인 완료`로 표현하지 않는다.
4. manifest의 모든 batch를 각 batch의 `next_cursor=null`까지 읽는다. 각 호출의
   `next_cursor`는 수정하지 않고 다음 호출에 넘긴다. 마지막 page에만 반환되는
   `batch_coverage_digest`를 batch ID와 함께 보존한다. 중간 page digest를 만들거나
   추측하지 않는다. 임의 방, 사용자, 경로, SQL 또는 날짜를 도구에 넘기지 않는다.
5. snapshot mismatch가 나면 이전 결과를 버리고 manifest부터 한 번만 다시 시작한다.
   두 번째 mismatch는 불완전으로 종료한다.
6. 모든 batch의 최종 digest를 `coverage:[{batch_id,coverage_digest}]`로 만들어
   `reconcile`을 호출한다. `complete=true`일 때만
   `전건 요약 완료`, `누락 없음`, `전체`라고 쓸 수 있다.

```json
{
  "operation": "reconcile",
  "snapshot_token": "<manifest token>",
  "coverage": [{ "batch_id": "<id>", "coverage_digest": "<final page digest>" }]
}
```

manifest의 `totals.text_utf8_bytes <= 131072`, `totals.messages <= 1000`,
전체 `page_count` 합계가 64 이하이면 **반드시 현재 세션에서** 모든 batch와 page를
순차 처리한다. 이 범위에서는 `sessions_spawn`을 호출하지 않는다. OC1 대표 주간량
(56,734 bytes, 458 messages, 43 pages)은 이 직접 처리 경로다.

조회 중에는 `jitech_kakaowork_period_records`만 사용한다. `exec`, `read`, `write`,
`process`, `gateway`, 파일 탐색, 임시 스크립트 작성 또는 DB 직접 접근으로 우회하지
않는다. 모든 `read_batch` 호출에는 같은 manifest의 `snapshot_token`, 현재
`batch_id`, 직전 응답의 `next_cursor`를 그대로 전달한다.

위 세 상한 중 하나라도 넘더라도 제한된 batch 전용 agent가 실제로 구성되어 있다는
증거가 없으면 `sessions_spawn`을 시도하지 않는다. 확인된 manifest 수치와 미처리 범위를
밝혀 불완전으로 종료한다. 새 runner, 저장소, 스크립트 또는 상태 파일을 만들지 않는다.

## batch 결과 형식

각 batch에서 다음 항목만 추출하고 모든 주장에 하나 이상의 `stable_message_id`를 붙인다.

- 의사결정
- 요청과 담당자
- 일정과 기한
- 문제와 위험
- 수치와 상태 변화
- 미응답 또는 후속 확인 필요
- 저가치 항목의 종류별 건수와 대표 근거 ID

서로 다른 방, 발신자, 요청자 또는 출처를 같은 행위자로 합치지 않는다. 이름이 같아도
`sender.user_id`가 다르면 별개로 유지한다. 복호화 실패나 안전하지 않은 첨부 reference의
내용을 추정하지 않는다.

## 최종 답변

먼저 절대 기간, 원본 메시지 수, 처리 수, 누락·중복·복호화 실패·안전하지 않은 첨부
수를 밝힌다. 그 뒤 핵심 요약을 위 범주로 정리하고, 부록에 방·batch별 coverage와
실패 내역을 둔다. 근거 표기는 최소한
`[카카오워크 | 방 | local_time | stable_message_id]`를
포함한다.

`reconcile.complete=false`이면 제목과 결론에 `불완전`을 명시하고, 확인된 내용과
확인하지 못한 범위를 분리한다. `missing_batch_ids`, `duplicate_batch_ids`,
`unknown_batch_ids`, `digest_mismatch_batch_ids`, `failed_messages`,
`uncovered_messages`, freshness를 생략하지 않는다.
