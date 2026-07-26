// Compilation wrapper for the 16px Noto Sans KR face (가-힣, BPP 4).
//
// IPS10-ONLY: the bitmap is ~1.5MB of flash — the 10" P4 board has a 6MB
// dual-OTA app slot with room to spare, but smaller boards (ttgo 8MB single
// layouts, tc001) must not carry it. The generated data lives in
// font_noto_kr_16.cinc (NOT compiled directly — .cinc is outside the
// build_src_filter's *.c glob); regenerate it with:
//
//   npx lv_font_conv --font NotoSansKR[wght].ttf --bpp 4 --size 16 \
//     --range 0xAC00-0xD7A3 --format lvgl --no-compress \
//     --output esp32/src/ui/fonts/font_noto_kr_16.cinc --lv-include lvgl.h
#if defined(BOARD_IPS10) || defined(BOARD_T_DISPLAY_PRO)
#include "font_noto_kr_16.cinc"
#endif
