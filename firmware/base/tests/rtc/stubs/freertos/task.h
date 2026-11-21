#pragma once
#include "FreeRTOS.h"
using TaskHandle_t = void*;
using TaskFunction_t = void (*)(void*);
BaseType_t xTaskCreate(TaskFunction_t worker,
                       const char* name,
                       std::uint32_t stack,
                       void* arg,
                       UBaseType_t priority,
                       TaskHandle_t* handle);
void vTaskDelay(TickType_t ticks);
