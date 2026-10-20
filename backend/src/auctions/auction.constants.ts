/** 종료 이 시간 안에 입찰이 들어오면 종료 시각을 현재 + 이 시간으로 늦춘다. */
export const SNIPING_WINDOW_MS = 5 * 60 * 1000;

/** 한 경매에서 연장할 수 있는 최대 횟수 (무한 연장 방지) */
export const MAX_EXTENSIONS = 20;

/** 종료된 경매를 정산하는 폴링 주기 */
export const SETTLE_INTERVAL_MS = 5_000;

/** 마감 이 시간 안으로 들어온 경매를 관심 목록 사용자에게 알린다. */
export const ENDING_SOON_WINDOW_MS = 60 * 60 * 1000;

/** 종료 임박 대상을 훑는 주기 */
export const ENDING_SOON_INTERVAL_MS = 60_000;
