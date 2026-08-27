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

`jitech_kakaowork_period_records`를 다음 형식으로 정확히 한 번 호출한다.

```json
{ "operation": "read_period", "period": "rolling_7d" }
```

`지난주` 요청에서만 `period`를 `previous_calendar_week`로 바꾼다. 모델이 manifest,
batch, page, cursor 또는 coverage digest를 관리하지 않는다. 임의 방, 사용자, 경로,
SQL 또는 날짜를 도구에 넘기지 않으며 다른 검색·파일·실행 도구로 우회하지 않는다.

- `status=unavailable|error`이면 `connection.diagnostic`과 확인하지 못한 범위를 답한다.
- `status=oversize`이면 일부 원문을 전체처럼 요약하지 않는다. 원본 건수, 반환 0건,
  필요한 결과 크기와 한도를 밝히고 `불완전`으로 종료한다.
- `source_total_messages=0`이면 연결 여부, 절대 시작·종료시각, 0건을 함께 답한다.
  freshness가 stale이면 `전건 확인 완료`라고 표현하지 않는다.
- `records`는 해당 기간의 승인된 원문 전건이다. 별도 pagination이나 재호출을 만들지 않는다.

## 요약 규칙

모든 핵심 주장에 하나 이상의 `stable_message_id`를 붙이고 다음 범주로 정리한다.

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

먼저 절대 기간, 원본 메시지 수, 반환·처리·실패·미반환·중복 건수와 freshness를 밝힌다.
그 뒤 고객이 바로 판단하고 행동할 수 있도록 핵심 요약을 위 범주로 정리한다. 근거 표기는
최소한 `[카카오워크 | 방 | local_time | stable_message_id]`를 포함한다.

도구의 `complete=true`일 때만 `전건 요약 완료`, `누락 없음`, `전체`라고 쓸 수 있다.
`complete=false`이면 제목과 결론에 `불완전`을 명시하고, 확인된 내용과 확인하지 못한
범위를 분리한다. `failed_messages`, `uncovered_messages`, `duplicate_messages`,
`unsafe_attachment_references`, freshness를 생략하지 않는다.
