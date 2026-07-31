#if defined(BOARD_IPS10)
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_system.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_check.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch.h"
#include "esp_lcd_gsl3680.h"
#include "gsl_point_id.h"

#define TAG "gsl3680"

/* gsl3680 registers */
#define ESP_LCD_TOUCH_GSL3680_READ_XY_REG     (0x80)

/* gsl3680 support key num */
#define ESP_gsl3680_TOUCH_MAX_BUTTONS         (9)


unsigned int gsl_config_data_id[] =
{
	0xccb69a,
	0x200,
	0,0,
	0,
	0,0,0,
	0,0,0,0,0,0,0,0x1cc86fd6,


	0x40000d00,0xa,0xe001a,0xe001a,0x3200500,0,0x5100,0x8e00,
	0,0x320014,0,0x14,0,0,0,0,
	0x8,0x4000,0x1000,0x10170002,0x10110000,0,0,0x4040404,
	0x1b6db688,0x64,0xb3000f,0xad0019,0xa60023,0xa0002d,0xb3000f,0xad0019,
	0xa60023,0xa0002d,0xb3000f,0xad0019,0xa60023,0xa0002d,0xb3000f,0xad0019,
	0xa60023,0xa0002d,0x804000,0x90040,0x90001,0,0,0,
	0,0,0,0x14012c,0xa003c,0xa0078,0x400,0x1081,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,

	0,//key_map
	0x3200384,0x64,0x503e8,//0
	0,0,0,//1
	0,0,0,//2
	0,0,0,//3
	0,0,0,//4
	0,0,0,//5
	0,0,0,//6
	0,0,0,//7

	0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,


	0x220,
	0,0,0,0,0,0,0,0,
	0x10203,0x4050607,0x8090a0b,0xc0d0e0f,0x10111213,0x14151617,0x18191a1b,0x1c1d1e1f,
	0x20212223,0x24252627,0x28292a2b,0x2c2d2e2f,0x30313233,0x34353637,0x38393a3b,0x3c3d3e3f,
	0x10203,0x4050607,0x8090a0b,0xc0d0e0f,0x10111213,0x14151617,0x18191a1b,0x1c1d1e1f,
	0x20212223,0x24252627,0x28292a2b,0x2c2d2e2f,0x30313233,0x34353637,0x38393a3b,0x3c3d3e3f,

	0x10203,0x4050607,0x8090a0b,0xc0d0e0f,0x10111213,0x14151617,0x18191a1b,0x1c1d1e1f,
	0x20212223,0x24252627,0x28292a2b,0x2c2d2e2f,0x30313233,0x34353637,0x38393a3b,0x3c3d3e3f,

	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,

	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,

	0x10203,0x4050607,0x8090a0b,0xc0d0e0f,0x10111213,0x14151617,0x18191a1b,0x1c1d1e1f,
	0x20212223,0x24252627,0x28292a2b,0x2c2d2e2f,0x30313233,0x34353637,0x38393a3b,0x3c3d3e3f,

	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,


	0x3,
	0x101,0,0x100,0,
	0x20,0x10,0x8,0x4,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,

	0x4,0,0,0,0,0,0,0,
	0x3800680,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,0,
	0,0,0,0,0,0,0,
};



static TG_STATE_E tpc_gesture_id = TG_UNKNOWN_STATE;
static XY_DATA_T XY_Coordinate[MAX_FINGER_NUM]={0};
esp_lcd_touch_handle_t esp_lcd_touch_gsl3680;
static i2c_master_dev_handle_t gsl3680_i2c_dev;
static bool gsl3680_trace_enabled;

static uint8_t Finger_num = 0;
static TP_STATE_E tp_event = TP_PEN_NONE;
static uint8_t pre_pen_flag = 0;
static uint32_t pre_distance=0;
static uint32_t distance_flag = 0;
static uint16_t x_new = 0;
static uint16_t y_new = 0;
static uint16_t x_start = 0 , y_start = 0;
static uint8_t zoomOutDebounce = 0;
static uint8_t zoomInDebounce = 0;

static esp_err_t esp_lcd_touch_gsl3680_read_data(esp_lcd_touch_handle_t tp);
static bool esp_lcd_touch_gsl3680_get_xy(esp_lcd_touch_handle_t tp, uint16_t *x, uint16_t *y, uint16_t *strength, uint8_t *point_num, uint8_t max_point_num);
#if (CONFIG_ESP_LCD_TOUCH_MAX_BUTTONS > 0)
static esp_err_t esp_lcd_touch_gsl3680_get_button_state(esp_lcd_touch_handle_t tp, uint8_t n, uint8_t *state);
#endif
static esp_err_t esp_lcd_touch_gsl3680_del(esp_lcd_touch_handle_t tp);

/* I2C read/write */
static esp_err_t touch_gsl3680_i2c_read(esp_lcd_touch_handle_t tp, uint16_t reg, uint8_t *data, uint8_t len);
static esp_err_t touch_gsl3680_i2c_write(esp_lcd_touch_handle_t tp, uint16_t reg, uint8_t *data, uint8_t len);
static esp_err_t gsl3680_write_retry(esp_lcd_touch_handle_t tp, uint8_t reg, uint8_t *data, uint8_t len);

/* gsl3680 reset */
static esp_err_t touch_gsl3680_reset(esp_lcd_touch_handle_t tp);
/* Verify four-byte register transfers before the firmware burst. */
static esp_err_t touch_gsl3680_read_cfg(esp_lcd_touch_handle_t tp);
/* gsl3680 enter/exit sleep mode */
static esp_err_t esp_lcd_touch_gsl3680_enter_sleep(esp_lcd_touch_handle_t tp);
static esp_err_t esp_lcd_touch_gsl3680_exit_sleep(esp_lcd_touch_handle_t tp);
static esp_err_t esp_lcd_touch_gsl3680_startup_chip(esp_lcd_touch_handle_t tp);
static esp_err_t esp_lcd_touch_gsl3680_read_ram_fw(esp_lcd_touch_handle_t tp);
static esp_err_t esp_lcd_touch_gsl3680_load_fw(esp_lcd_touch_handle_t tp);
static esp_err_t esp_lcd_touch_gsl3680_clear_reg(esp_lcd_touch_handle_t tp);
static esp_err_t esp_lcd_touch_gsl3680_init(esp_lcd_touch_handle_t tp);
static TP_STATE_E _Get_Cal_msg(void);

esp_err_t esp_lcd_touch_new_i2c_gsl3680(i2c_master_bus_handle_t bus, const esp_lcd_touch_config_t *config, esp_lcd_touch_handle_t *out_touch)
{
    esp_err_t ret = ESP_OK;

    assert(bus != NULL);
    assert(config != NULL);
    assert(out_touch != NULL);
    *out_touch = NULL;
    gsl3680_i2c_dev = NULL;

    /* Prepare main structure */
    esp_lcd_touch_gsl3680 = heap_caps_calloc(1, sizeof(esp_lcd_touch_t), MALLOC_CAP_DEFAULT);
    ESP_GOTO_ON_FALSE(esp_lcd_touch_gsl3680, ESP_ERR_NO_MEM, err, TAG, "no mem for GSL3680 controller");

    /* Use the IDF master driver directly. The LCD panel-IO adapter is intended
     * for display command/parameter traffic and silently left the long GSL RAM
     * upload unusable on ESP32-P4 even though every transfer ACKed. */
    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = ESP_LCD_TOUCH_IO_I2C_GSL3680_ADDRESS,
        .scl_speed_hz = 400000,
        .scl_wait_us = 13000,
    };
    ret = i2c_master_bus_add_device(bus, &dev_config, &gsl3680_i2c_dev);
    ESP_GOTO_ON_ERROR(ret, err, TAG, "failed to add GSL3680 I2C device");

    /* Only supported callbacks are set */
    esp_lcd_touch_gsl3680->read_data = esp_lcd_touch_gsl3680_read_data;
    esp_lcd_touch_gsl3680->get_xy = esp_lcd_touch_gsl3680_get_xy;
#if (CONFIG_ESP_LCD_TOUCH_MAX_BUTTONS > 0)
    esp_lcd_touch_gsl3680->get_button_state = esp_lcd_touch_gsl3680_get_button_state;
#endif
    esp_lcd_touch_gsl3680->del = esp_lcd_touch_gsl3680_del;
    //esp_lcd_touch_gsl3680->enter_sleep = esp_lcd_touch_gsl3680_enter_sleep;
    //esp_lcd_touch_gsl3680->exit_sleep = esp_lcd_touch_gsl3680_exit_sleep;

    /* Mutex */
    esp_lcd_touch_gsl3680->data.lock.owner = portMUX_FREE_VAL;

    /* Save config */
    memcpy(&esp_lcd_touch_gsl3680->config, config, sizeof(esp_lcd_touch_config_t));
    //esp_lcd_touch_io_gsl3680_config_t *gsl3680_config = (esp_lcd_touch_io_gsl3680_config_t *)esp_lcd_touch_gsl3680->config.driver_data;

    /* Prepare pin for touch controller reset */
    if (esp_lcd_touch_gsl3680->config.rst_gpio_num != GPIO_NUM_NC) {
        const gpio_config_t rst_gpio_config = {
            .mode = GPIO_MODE_OUTPUT,
            .pin_bit_mask = BIT64(esp_lcd_touch_gsl3680->config.rst_gpio_num),
        };
        ret = gpio_config(&rst_gpio_config);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GPIO config failed");
    }

    if (esp_lcd_touch_gsl3680->config.rst_gpio_num != GPIO_NUM_NC && esp_lcd_touch_gsl3680->config.int_gpio_num != GPIO_NUM_NC) {
        /* Prepare pin for touch controller int */
        const gpio_config_t int_gpio_config = {
            .mode = GPIO_MODE_OUTPUT,
            .intr_type = GPIO_INTR_DISABLE,
            .pull_down_en = 0,
            .pull_up_en = 1,
            .pin_bit_mask = BIT64(esp_lcd_touch_gsl3680->config.int_gpio_num),
        };
        ret = gpio_config(&int_gpio_config);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GPIO config failed");

        ret = gpio_set_level(esp_lcd_touch_gsl3680->config.rst_gpio_num, esp_lcd_touch_gsl3680->config.levels.reset);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GPIO set level error!");
        ret = gpio_set_level(esp_lcd_touch_gsl3680->config.int_gpio_num, 0);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GPIO set level error!");
        vTaskDelay(pdMS_TO_TICKS(10));

        /* Select I2C addr, set output high or low */
        uint32_t gpio_level = 0;
        //if (ESP_LCD_TOUCH_IO_I2C_GSL3680_ADDRESS == gsl3680_config->dev_addr) {
            //gpio_level = 0;
        //} else {
            //gpio_level = 0;
           // ESP_LOGE(TAG, "Addr (0x%X) is invalid", gsl3680_config->dev_addr);
        //}
        ret = gpio_set_level(esp_lcd_touch_gsl3680->config.int_gpio_num, gpio_level);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GPIO set level error!");
        vTaskDelay(pdMS_TO_TICKS(1));

        ret = gpio_set_level(esp_lcd_touch_gsl3680->config.rst_gpio_num, !esp_lcd_touch_gsl3680->config.levels.reset);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GPIO set level error!");
        vTaskDelay(pdMS_TO_TICKS(10));

        vTaskDelay(pdMS_TO_TICKS(50));
    } else {
        ESP_LOGW(TAG, "Unable to initialize the I2C address");
        /* Reset controller */
        ret = touch_gsl3680_reset(esp_lcd_touch_gsl3680);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GSL3680 reset failed");
    }

    /* Verify the bus path, then load the controller's volatile RAM firmware
     * and verify its run marker. The four-byte 0xf0 transaction is required
     * by the known-working ESPHome P4 implementation. */
    ESP_LOGI(TAG,"init gls3680");
    ret = touch_gsl3680_read_cfg(esp_lcd_touch_gsl3680);
    ESP_GOTO_ON_ERROR(ret, err, TAG, "GSL3680 configuration read failed");
    ret = esp_lcd_touch_gsl3680_init(esp_lcd_touch_gsl3680);
    ESP_GOTO_ON_ERROR(ret, err, TAG, "GSL3680 firmware initialization failed");

    /* Prepare pin for touch interrupt */
    if (esp_lcd_touch_gsl3680->config.int_gpio_num != GPIO_NUM_NC) {
        const gpio_config_t int_gpio_config = {
            .mode = GPIO_MODE_INPUT,
            .intr_type = (esp_lcd_touch_gsl3680->config.levels.interrupt ? GPIO_INTR_POSEDGE : GPIO_INTR_NEGEDGE),
            .pin_bit_mask = BIT64(esp_lcd_touch_gsl3680->config.int_gpio_num)
        };
        ret = gpio_config(&int_gpio_config);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GPIO config failed");

        /* Register interrupt callback */
        if (esp_lcd_touch_gsl3680->config.interrupt_callback) {
            esp_lcd_touch_register_interrupt_callback(esp_lcd_touch_gsl3680, esp_lcd_touch_gsl3680->config.interrupt_callback);
        }
    }

err:
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Error (0x%x)! Touch controller GSL3680 initialization failed!", ret);
        if (esp_lcd_touch_gsl3680) {
            esp_lcd_touch_gsl3680_del(esp_lcd_touch_gsl3680);
            esp_lcd_touch_gsl3680 = NULL;
        }
    }

    *out_touch = esp_lcd_touch_gsl3680;

    return ret;

}

void esp_lcd_touch_gsl3680_set_trace(bool enabled)
{
    gsl3680_trace_enabled = enabled;
}


static esp_err_t esp_lcd_touch_gsl3680_enter_sleep(esp_lcd_touch_handle_t tp)
{
    // esp_err_t err = touch_gsl3680_i2c_write(tp, ESP_LCD_TOUCH_GSL3680_ENTER_SLEEP, 0x05);
    // ESP_RETURN_ON_ERROR(err, TAG, "Enter Sleep failed!");

    if (tp->config.rst_gpio_num != GPIO_NUM_NC) {
        ESP_RETURN_ON_ERROR(gpio_set_level(tp->config.rst_gpio_num, 0), TAG, "GPIO set level error!");
        vTaskDelay(pdMS_TO_TICKS(20));
    }

    return ESP_OK;
}

static esp_err_t esp_lcd_touch_gsl3680_exit_sleep(esp_lcd_touch_handle_t tp)
{
    esp_err_t ret;
    ESP_RETURN_ON_ERROR(gpio_set_level(tp->config.rst_gpio_num, 1), TAG, "GPIO set level error!");
    vTaskDelay(pdMS_TO_TICKS(20));


    return ESP_OK;
}

static esp_err_t esp_lcd_touch_gsl3680_read_data(esp_lcd_touch_handle_t tp)
{
    esp_err_t err;
    uint8_t touch_data[24] = {0};
    uint8_t touch_cnt = 0;
    uint16_t x_poit, y_poit, x2_poit, y2_poit;
	uint16_t  distance = 0, chazhi = 0;
    size_t i = 0;

    assert(tp != NULL);

// #ifdef USE_GSL_NOID_VERSION
    struct gsl_touch_info cinfo = {0};
    unsigned int tmp1 = 0;
    uint8_t buf[4] = {0};
// #endif

    memset(XY_Coordinate,0,sizeof(XY_Coordinate));

    err = touch_gsl3680_i2c_read(tp, ESP_LCD_TOUCH_GSL3680_READ_XY_REG, touch_data, 24);
    if (err != ESP_OK) {
        Finger_num = 0;
        return err;
    }
    if (gsl3680_trace_enabled) {
        static TickType_t last_trace_tick;
        const TickType_t now = xTaskGetTickCount();
        bool nonzero = false;
        for (size_t raw_i = 0; raw_i < sizeof(touch_data); raw_i++) {
            nonzero |= touch_data[raw_i] != 0;
        }
        const TickType_t interval = pdMS_TO_TICKS(nonzero ? 120 : 1000);
        if ((now - last_trace_tick) >= interval) {
            last_trace_tick = now;
            printf("[TouchRaw] irq=%d data=", gpio_get_level(tp->config.int_gpio_num));
            for (size_t raw_i = 0; raw_i < 12; raw_i++) {
                printf("%02x", touch_data[raw_i]);
            }
            printf("\n");
        }
    }
    Finger_num = touch_data[0];
    // ESP_LOGI(TAG,"0x80 = %d",touch_data[0]);

    x_poit = ((touch_data[7]&0x0f)<<8 )|touch_data[6];
	y_poit = (touch_data[5]<<8)|touch_data[4];
	x2_poit = ((touch_data[11]&0x0f)<<8 )|touch_data[10];
	y2_poit = (touch_data[9]<<8)|touch_data[8];

// #ifdef USE_GSL_NOID_VERSION
			cinfo.finger_num = Finger_num;
			cinfo.x[0] = x_poit;
			cinfo.y[0] = y_poit;
			cinfo.id[0] = ((touch_data[7]&0xf0)>>4);
			cinfo.x[1] = x2_poit;
			cinfo.y[1] = y2_poit;
			cinfo.id[1] = ((touch_data[11]&0xf0)>>4);
			cinfo.finger_num = (touch_data[3]<<24)|(touch_data[2]<<16)|
				(touch_data[1]<<8)|touch_data[0];

			gsl_alg_id_main(&cinfo);
			tmp1=gsl_mask_tiaoping();
			//SCI_TRACE_LOW("[tp-gsl] tmp1=%x\n", tmp1);
			if(tmp1>0&&tmp1<0xffffffff)
			{
				uint8 addr = 0xf0;
				buf[0]=0xa;buf[1]=0;buf[2]=0;buf[3]=0;
				touch_gsl3680_i2c_write(tp,addr, buf, 4);
				addr = 0x8;
				buf[0]=(uint8)(tmp1 & 0xff);
				buf[1]=(uint8)((tmp1>>8) & 0xff);
				buf[2]=(uint8)((tmp1>>16) & 0xff);
				buf[3]=(uint8)((tmp1>>24) & 0xff);
				//SCI_TRACE_LOW("tmp1=%08x,buf[0]=%02x,buf[1]=%02x,buf[2]=%02x,buf[3]=%02x\n", tmp1,buf[0],buf[1],buf[2],buf[3]);
				touch_gsl3680_i2c_write(tp,addr, buf, 4);
			}
			Finger_num = cinfo.finger_num;
// #endif


// #ifdef USE_GSL_NOID_VERSION
			XY_Coordinate[0].x_position =  cinfo.x[0];
			XY_Coordinate[0].y_position =  cinfo.y[0];
			XY_Coordinate[0].finger_id = cinfo.id[0];
			XY_Coordinate[1].x_position =  cinfo.x[1];
			XY_Coordinate[1].y_position =  cinfo.y[1];
			XY_Coordinate[1].finger_id = cinfo.id[1];
// #else
// 			XY_Coordinate[0].x_position = x_poit;
// 			XY_Coordinate[0].y_position = y_poit;
// 			XY_Coordinate[1].x_position = x2_poit;
// 			XY_Coordinate[1].y_position = y2_poit;
// #endif
    // i=0;
    // if(Finger_num >0)
    // printf("%s: %d[i], %d[x_position], %d[y_position], %d[finger_id], %d[finger_num]\n",
    //       __func__, i, XY_Coordinate[i].x_position, XY_Coordinate[i].y_position, XY_Coordinate[i].finger_id,Finger_num);
    // i=1;
    // printf("%s: %d[i], %d[x_position], %d[y_position], %d[finger_id], %d[finger_num]\n",
    //       __func__, i, XY_Coordinate[i].x_position, XY_Coordinate[i].y_position, XY_Coordinate[i].finger_id,Finger_num);

    if(Finger_num > 1)
	{
		distance_flag ++;
		distance = (x_poit-x2_poit)*(x_poit-x2_poit) + (y_poit-y2_poit)*(y_poit-y2_poit);
		chazhi = distance - pre_distance;
		if(distance_flag >= 3)
		{
			if( chazhi > 900 )
			{
				zoomOutDebounce = 0;
				zoomInDebounce ++;
				if(zoomInDebounce > 3)
				{
					tpc_gesture_id = TG_ZOOM_IN;
					zoomInDebounce = 0;
				}
			}
			else if( chazhi < -900 )
			{
				zoomInDebounce = 0;
				zoomOutDebounce ++;
				if(zoomOutDebounce > 3)
				{
					tpc_gesture_id = TG_ZOOM_OUT;
					zoomOutDebounce = 0;
				}
			}
			else
			{
				tpc_gesture_id = TG_NO_DETECT;
			}
		}

		pre_distance = distance;
		}
	else
		{
		tpc_gesture_id = TG_NO_DETECT;
		distance_flag = 0;
		pre_distance = 0;
		zoomInDebounce = 0;
		zoomOutDebounce = 0;
	}

    return ESP_OK;
}

static bool esp_lcd_touch_gsl3680_get_xy(esp_lcd_touch_handle_t tp, uint16_t *x, uint16_t *y, uint16_t *strength, uint8_t *point_num, uint8_t max_point_num)
{
    assert(tp != NULL);
    assert(x != NULL);
    assert(y != NULL);
    assert(point_num != NULL);
    assert(max_point_num > 0);

    portENTER_CRITICAL(&tp->data.lock);

    uint8_t count = Finger_num;
    if (count > MAX_FINGER_NUM) count = MAX_FINGER_NUM;
    if (count > max_point_num) count = max_point_num;
    *point_num = count;
    for (uint8_t i = 0; i < count; i++) {
        x[i] = XY_Coordinate[i].x_position;
        y[i] = XY_Coordinate[i].y_position;
        if (strength) strength[i] = XY_Coordinate[i].finger_id;
    }


    portEXIT_CRITICAL(&tp->data.lock);

    return (*point_num > 0);
}

#if (CONFIG_ESP_LCD_TOUCH_MAX_BUTTONS > 0)
static esp_err_t esp_lcd_touch_gsl3680_get_button_state(esp_lcd_touch_handle_t tp, uint8_t n, uint8_t *state)
{
    esp_err_t err = ESP_OK;
    assert(tp != NULL);
    assert(state != NULL);

    *state = 0;

    portENTER_CRITICAL(&tp->data.lock);

    if (n > tp->data.buttons) {
        err = ESP_ERR_INVALID_ARG;
    } else {
        *state = tp->data.button[n].status;
    }

    portEXIT_CRITICAL(&tp->data.lock);

    return err;
}
#endif

static esp_err_t esp_lcd_touch_gsl3680_del(esp_lcd_touch_handle_t tp)
{
    assert(tp != NULL);

    /* Reset GPIO pin settings */
    if (tp->config.int_gpio_num != GPIO_NUM_NC) {
        gpio_reset_pin(tp->config.int_gpio_num);
        if (tp->config.interrupt_callback) {
            gpio_isr_handler_remove(tp->config.int_gpio_num);
        }
    }

    /* Reset GPIO pin settings */
    if (tp->config.rst_gpio_num != GPIO_NUM_NC) {
        gpio_reset_pin(tp->config.rst_gpio_num);
    }

    if (gsl3680_i2c_dev) {
        i2c_master_bus_rm_device(gsl3680_i2c_dev);
        gsl3680_i2c_dev = NULL;
    }

    free(tp);

    return ESP_OK;
}

/*===================================================================================================================================================================================================*/
static esp_err_t esp_lcd_touch_gsl3680_init(esp_lcd_touch_handle_t tp)
{
    ESP_LOGI(TAG,"start init");
    // GSL3680 firmware lives in volatile controller RAM. The upload routine
    // verifies the full image before the core is started, then 0xb0 must expose
    // the conventional 0x5a5a5a5a running marker.
    for (int attempt = 1; attempt <= 2; attempt++) {
        esp_err_t ret = esp_lcd_touch_gsl3680_clear_reg(tp);
        if (ret == ESP_OK) ret = touch_gsl3680_reset(tp);
        if (ret == ESP_OK) ret = esp_lcd_touch_gsl3680_load_fw(tp);
        if (ret == ESP_OK) ret = esp_lcd_touch_gsl3680_startup_chip(tp);
        if (ret == ESP_OK) {
            esp_err_t marker = esp_lcd_touch_gsl3680_read_ram_fw(tp);
            if (marker == ESP_OK) {
                ESP_LOGI(TAG, "0xb0 run marker confirmed");
                ESP_LOGI(TAG, "firmware running after attempt %d", attempt);
                return ESP_OK;
            }
            ret = marker;
        }
        printf("[TouchInit] attempt %d failed: %s\n", attempt, esp_err_to_name(ret));
    }
    return ESP_ERR_INVALID_RESPONSE;
}


static esp_err_t touch_gsl3680_reset(esp_lcd_touch_handle_t tp)
{
    unsigned char write_buf[4] = {0};
    uint8_t addr;
    assert(tp != NULL);

    ESP_RETURN_ON_ERROR(gpio_set_level(tp->config.rst_gpio_num, 0), TAG, "GPIO set level error!");
    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_RETURN_ON_ERROR(gpio_set_level(tp->config.rst_gpio_num, 1), TAG, "GPIO set level error!");
    vTaskDelay(pdMS_TO_TICKS(20));

    addr = 0xe0;
    write_buf[0] = 0x88;
    ESP_RETURN_ON_ERROR(gsl3680_write_retry(tp, addr, write_buf, 1), TAG, "GSL3680 core reset failed");
    vTaskDelay(pdMS_TO_TICKS(10));

    addr = 0xe4;
    write_buf[0]=0x04;
    ESP_RETURN_ON_ERROR(gsl3680_write_retry(tp, addr, write_buf, 1), TAG, "GSL3680 clock reset failed");
    vTaskDelay(pdMS_TO_TICKS(10));

    write_buf[0] =0x00;
    write_buf[1] =0x00;
    write_buf[2] =0x00;
    write_buf[3] =0x00;
    ESP_RETURN_ON_ERROR(gsl3680_write_retry(tp, 0xbc, write_buf, 4), TAG, "GSL3680 power reset failed");

    vTaskDelay(pdMS_TO_TICKS(10));

    return ESP_OK;
}

static esp_err_t touch_gsl3680_read_cfg(esp_lcd_touch_handle_t tp)
{
    uint8_t before[4] = {0};
    uint8_t after[4] = {0};
    uint8_t write[4] = {0x12, 0x34, 0x56, 0x00};
    assert(tp != NULL);

    vTaskDelay(pdMS_TO_TICKS(50));
    ESP_RETURN_ON_ERROR(touch_gsl3680_i2c_read(tp, 0xf0, before, 4),
                        TAG, "GSL3680 config pre-read failed");
    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_RETURN_ON_ERROR(touch_gsl3680_i2c_write(tp, 0xf0, write, 4),
                        TAG, "GSL3680 config write failed");
    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_RETURN_ON_ERROR(touch_gsl3680_i2c_read(tp, 0xf0, after, 4),
                        TAG, "GSL3680 config post-read failed");
    printf("[TouchInit] page before=%02x%02x%02x%02x after=%02x%02x%02x%02x\n",
           before[3], before[2], before[1], before[0],
           after[3], after[2], after[1], after[0]);
    return memcmp(after, write, sizeof(write)) == 0
        ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

/* Control-register writes are single bytes at bus-contention-prone moments
 * (right after a 4356-write burst, while the LVGL indev polls the same bus).
 * One dropped write here is not cosmetic: losing the 0xe0 start command leaves
 * the firmware loaded but never executing, which reads downstream as "the
 * controller reports no touches" with nothing else amiss. Retry them. */
static esp_err_t gsl3680_write_retry(esp_lcd_touch_handle_t tp, uint8_t reg,
                                     uint8_t *data, uint8_t len)
{
    esp_err_t err = touch_gsl3680_i2c_write(tp, reg, data, len);
    for (int attempt = 0; err != ESP_OK && attempt < 5; attempt++) {
        vTaskDelay(pdMS_TO_TICKS(5));
        err = touch_gsl3680_i2c_write(tp, reg, data, len);
    }
    return err;
}

static esp_err_t esp_lcd_touch_gsl3680_startup_chip(esp_lcd_touch_handle_t tp)
{
    esp_err_t ret = ESP_OK;
    uint8_t write_buf[4] = {0};
    uint8_t addr = 0xe0;
    // Let the bus settle after the firmware burst before the start command.
    vTaskDelay(pdMS_TO_TICKS(10));
    // Core-control registers use the standard one-byte command width even
    // though this panel needs four bytes for the verified page-select pass.
    esp_err_t started = gsl3680_write_retry(tp, addr, write_buf, 1);
    if (started != ESP_OK) {
        ESP_LOGE(TAG,"gsl3680 start command (0xe0) failed -- firmware will not run");
        return started;
    }
    vTaskDelay(pdMS_TO_TICKS(10));

    gsl_DataInit(gsl_config_data_id);
    return ret;
}

static esp_err_t esp_lcd_touch_gsl3680_read_ram_fw(esp_lcd_touch_handle_t tp)
{
    uint8_t read_buf[4];
    uint8_t addr = 0xb0;
    ESP_LOGI(TAG,"enter read_ram_fw");
    vTaskDelay(pdMS_TO_TICKS(30));
    ESP_RETURN_ON_ERROR(touch_gsl3680_i2c_read(tp, addr, (uint8_t *)&read_buf, 4), TAG, "gsl3680 read error!");
    printf("[TouchInit] status 0xb0=%02x%02x%02x%02x\n",
           read_buf[3], read_buf[2], read_buf[1], read_buf[0]);
    if(read_buf[3] != 0x5a || read_buf[2] != 0x5a || read_buf[1] != 0x5a || read_buf[0] != 0x5a)
    {

        return ESP_FAIL;
    }
    return ESP_OK;
}

static esp_err_t touch_gsl3680_i2c_read(esp_lcd_touch_handle_t tp, uint16_t reg, uint8_t *data, uint8_t len)
{
    assert(tp != NULL);
    assert(data != NULL);
    if (!gsl3680_i2c_dev || reg > UINT8_MAX) return ESP_ERR_INVALID_STATE;
    uint8_t reg8 = (uint8_t)reg;
    return i2c_master_transmit_receive(gsl3680_i2c_dev, &reg8, 1, data, len, 20);

}

static esp_err_t touch_gsl3680_i2c_write(esp_lcd_touch_handle_t tp, uint16_t reg, uint8_t *data,uint8_t len)
{
    assert(tp != NULL);
    if (!gsl3680_i2c_dev || reg > UINT8_MAX || len > 4) return ESP_ERR_INVALID_ARG;
    uint8_t tx[5];
    tx[0] = (uint8_t)reg;
    memcpy(&tx[1], data, len);
    return i2c_master_transmit(gsl3680_i2c_dev, tx, (size_t)len + 1, 20);
}

static esp_err_t esp_lcd_touch_gsl3680_load_fw(esp_lcd_touch_handle_t tp)
{
    ESP_LOGI(TAG,"start load fw");
    uint8_t addr;
    unsigned char wrbuf[4];
    uint16_t source_line = 0;
    uint16_t source_len = sizeof(GSLX680_FW) / sizeof(struct fw_data);
    // The upstream vendor loop discarded every write result and then logged
    // "load fw success" unconditionally. On this panel two writes out of several
    // thousand fail on each boot, and a Silead controller with a partially
    // written blob comes up, answers I2C, and simply never reports a touch --
    // which is exactly the symptom that made this look like a mapping bug.
    // Retry each failing write, and report what actually happened.
    // Try the vendor's standard one-byte page selectors first. Some controller
    // revisions instead require a four-byte little-endian page word, so retain
    // that as a verified fallback rather than assuming ACK means accepted.
    for (uint8_t page_bytes = 1; page_bytes <= 4; page_bytes += 3) {
        int failures = 0, retried = 0;
        for(source_line=0;source_line<source_len;source_line++)
        {
            addr = GSLX680_FW[source_line].offset;
            wrbuf[0] = (uint8_t)(GSLX680_FW[source_line].val & 0x000000ff);
            wrbuf[1] = (uint8_t)((GSLX680_FW[source_line].val & 0x0000ff00) >> 8);
            wrbuf[2] = (uint8_t)((GSLX680_FW[source_line].val & 0x00ff0000) >> 16);
            wrbuf[3] = (uint8_t)((GSLX680_FW[source_line].val & 0xff000000) >> 24);
            const uint8_t len = (addr == 0xf0) ? page_bytes : 4;
            esp_err_t err = touch_gsl3680_i2c_write(tp,addr,wrbuf,len);
            for (int attempt = 0; err != ESP_OK && attempt < 3; attempt++) {
                retried++;
                vTaskDelay(pdMS_TO_TICKS(2));
                err = touch_gsl3680_i2c_write(tp,addr,wrbuf,len);
            }
            if (err != ESP_OK) failures++;
        }
        if (failures || retried) {
            ESP_LOGW(TAG,"load fw (%u-byte page): %d write(s) retried, %d still failed (of %u)",
                     page_bytes, retried, failures, (unsigned)source_len);
        }
        if (failures) continue;

        // Page 2 offsets 0x60..0x67 are fixed in the bundled image. ACK-only
        // verification cannot detect a page-selector width mismatch, so read
        // these bytes back before asking the controller core to execute them.
        uint8_t page[4] = {0x02, 0, 0, 0};
        uint8_t actual[8] = {0};
        // Configuration-register access on this IPS10 is demonstrably
        // four-byte-wide. Use that independently of the upload stream width:
        // a one-byte verification write can read page zero and falsely make a
        // correct vendor-format upload look empty.
        esp_err_t verify = touch_gsl3680_i2c_write(tp, 0xf0, page, 4);
        if (verify == ESP_OK) {
            verify = touch_gsl3680_i2c_read(tp, 0x60, actual, sizeof(actual));
        }
        const uint8_t expected[8] = {0xb0, 0x00, 0x00, 0x00,
                                    0x0b, 0x00, 0x01, 0xf8};
        printf("[TouchInit] upload pageBytes=%u sentinel=%02x%02x%02x%02x"
               "%02x%02x%02x%02x\n",
               page_bytes, actual[7], actual[6], actual[5], actual[4],
               actual[3], actual[2], actual[1], actual[0]);
        if (verify == ESP_OK && memcmp(actual, expected, sizeof(expected)) == 0) {
            // A single sentinel catches page-width mistakes but not a dropped
            // write elsewhere in the executable image. Read every firmware
            // word back before starting the scan core. The controller rejects
            // 128-byte reads, so use its native four-byte word width.
            uint8_t word_data[4];
            unsigned verified_pages = 0;
            unsigned mismatches = 0;
            esp_err_t full_verify = ESP_OK;
            vTaskDelay(pdMS_TO_TICKS(5));
            for (uint16_t fw_i = 0; fw_i < source_len && full_verify == ESP_OK; fw_i++) {
                if (GSLX680_FW[fw_i].offset != 0xf0) continue;

                const uint32_t page_value = GSLX680_FW[fw_i].val;
                uint8_t selector[4] = {
                    (uint8_t)(page_value & 0xff),
                    (uint8_t)((page_value >> 8) & 0xff),
                    (uint8_t)((page_value >> 16) & 0xff),
                    (uint8_t)((page_value >> 24) & 0xff),
                };
                full_verify = gsl3680_write_retry(tp, 0xf0, selector, 4);
                if (full_verify != ESP_OK) break;
                vTaskDelay(pdMS_TO_TICKS(1));
                verified_pages++;

                for (uint16_t data_i = fw_i + 1;
                     data_i < source_len && GSLX680_FW[data_i].offset != 0xf0;
                     data_i++) {
                    const uint8_t offset = GSLX680_FW[data_i].offset;
                    full_verify = touch_gsl3680_i2c_read(tp, offset, word_data, sizeof(word_data));
                    for (int read_attempt = 0;
                         full_verify != ESP_OK && read_attempt < 3;
                         read_attempt++) {
                        vTaskDelay(pdMS_TO_TICKS(1));
                        full_verify = touch_gsl3680_i2c_read(tp, offset, word_data, sizeof(word_data));
                    }
                    if (full_verify != ESP_OK) break;
                    const uint32_t expected_word = GSLX680_FW[data_i].val;
                    const uint32_t actual_word =
                        ((uint32_t)word_data[0]) |
                        ((uint32_t)word_data[1] << 8) |
                        ((uint32_t)word_data[2] << 16) |
                        ((uint32_t)word_data[3] << 24);
                    if (actual_word != expected_word) {
                        if (mismatches < 8) {
                            printf("[TouchInit] verify mismatch page=%02x offset=%02x"
                                   " expected=%08lx actual=%08lx\n",
                                   selector[0], offset,
                                   (unsigned long)expected_word,
                                   (unsigned long)actual_word);
                        }
                        mismatches++;
                    }
                }
            }
            printf("[TouchInit] full verify: %u pages, %u mismatches, status=%s\n",
                   verified_pages, mismatches, esp_err_to_name(full_verify));
            if (full_verify == ESP_OK && mismatches == 0) {
                return ESP_OK;
            }
        }
        if (page_bytes == 1) {
            ESP_LOGW(TAG, "one-byte firmware upload did not verify; trying four-byte page selectors");
        } else {
            ESP_LOGE(TAG, "firmware RAM readback failed");
        }
    }
    return ESP_ERR_INVALID_RESPONSE;
}

static esp_err_t esp_lcd_touch_gsl3680_clear_reg(esp_lcd_touch_handle_t tp)
{
    uint8_t addr;
    uint8_t wrbuf[4] = {0};

    ESP_LOGI(TAG,"clear reg");
    // Standard Silead pre-load sequence. 0xe0=0x88 resets/halts the core while
    // its RAM image is replaced; 0xe0=0x00 starts it again. Omitting the reset
    // left the GSL3680 ACKing I2C but never producing the 0x5a status marker.
    addr = 0xe0;
    wrbuf[0] = 0x88;
    ESP_RETURN_ON_ERROR(gsl3680_write_retry(tp,addr,wrbuf,1), TAG, "GSL3680 core reset failed");
    vTaskDelay(pdMS_TO_TICKS(20));
    // 0x80 is the Silead touch-count register. The vendor BSP used
    // 0x88=0x01 here, which ACKs but leaves the scan engine disabled.
    addr = 0x80;
    wrbuf[0] = MAX_FINGER_NUM;
    ESP_RETURN_ON_ERROR(gsl3680_write_retry(tp,addr,wrbuf,1), TAG, "GSL3680 touch-count setup failed");
    vTaskDelay(pdMS_TO_TICKS(5));
    addr = 0xe4;
    wrbuf[0] = 0x04;
    ESP_RETURN_ON_ERROR(gsl3680_write_retry(tp,addr,wrbuf,1), TAG, "GSL3680 clock setup failed");
    vTaskDelay(pdMS_TO_TICKS(5));
    addr = 0xe0;
    wrbuf[0] = 0x00;
    ESP_RETURN_ON_ERROR(gsl3680_write_retry(tp,addr,wrbuf,1), TAG, "GSL3680 preload start failed");
    vTaskDelay(pdMS_TO_TICKS(20));

    return ESP_OK;
}

static TP_STATE_E _Get_Cal_msg(void)
{
    uint8 pen_flag = 0;
	uint16 x_poit, y_poit, x2_poit, y2_poit;
	int32 x_delta = 0 , y_delta = 0;

	pen_flag = Finger_num;
	x_poit = XY_Coordinate[0].x_position;
	y_poit = XY_Coordinate[0].y_position;
	x2_poit = XY_Coordinate[1].x_position;
	y2_poit = XY_Coordinate[1].y_position;

	if(pen_flag==0)
	{
		if(tp_event == TP_PEN_MOVE)//the last event=move
		{
			x_new = x_poit;
			y_new = y_poit;
		}
		else//the last event=down
		{
			x_new = x_start;
			y_new = y_start;
		}

		tp_event = TP_PEN_UP;
	}
	else if(pen_flag==2)
	{
		tp_event = TP_PEN_DOWN;
		x_start = x_poit;
		y_start = y_poit;
		x_new = x_poit;
		y_new = y_poit;
	}
	else if(pre_pen_flag!=1)//pen_flag=1,pre_pen_flag==0 or 2
	{
		tp_event = TP_PEN_DOWN;
		x_start = x_poit;
		y_start = y_poit;
		x_new = x_poit;
		y_new = y_poit;
	 }
	else// if((pen_flag==1)&&(pre_pen_flag==1))
	{
		x_delta = x_poit - x_start;
		y_delta = y_poit - y_start;
		if((x_delta>20)||(x_delta<-20)||(y_delta>25)||(y_delta<-25))
		{
			tp_event = TP_PEN_MOVE;
		}

		if(tp_event == TP_PEN_MOVE)
		{
			x_new = x_poit;
			y_new = y_poit;
		}
		else
		{
			x_new = x_start;
			y_new = y_start;
		}

	 }

	pre_pen_flag = pen_flag;
	return tp_event;
}
#endif
