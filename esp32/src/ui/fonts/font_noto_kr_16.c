// Compilation wrapper for the 16px Noto Sans KR face (가-힣, BPP 4).
//
// Large companion surfaces only: the bitmap is ~1.5MB of flash, so it is
// compiled only for boards whose 6MB OTA slot has room. The generated data lives in
// font_noto_kr_16.cinc (NOT compiled directly — .cinc is outside the
// build_src_filter's *.c glob); regenerate it with:
//
//   npx lv_font_conv --font NotoSansKR[wght].ttf --bpp 4 --size 16 \
//     --range 0xAC00-0xD7A3 --format lvgl --no-compress \
//     --output esp32/src/ui/fonts/font_noto_kr_16.cinc --lv-include lvgl.h
#if defined(BOARD_IPS10) || defined(BOARD_T_DISPLAY_PRO) || defined(BOARD_T_EMBED)
#include "font_noto_kr_16.cinc"
#endif
