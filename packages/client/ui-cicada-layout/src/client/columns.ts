/**
 * Pure geometry constants for the cicada root frame: sidebar and details
 * follow the native ui-layout contract widths; the pipeline column is a fixed
 * cicada addition (4-spec §2 四区).
 */

/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360
/** Pipeline column width (fixed; cicada.pipeline sidebar). */
export const PIPELINE_DEFAULT = 320
