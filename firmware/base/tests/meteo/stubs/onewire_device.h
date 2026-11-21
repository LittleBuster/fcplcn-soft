#pragma once
#include "onewire_bus.h"
struct FakeIterator;
using onewire_device_iter_handle_t = FakeIterator*;

struct onewire_device_t {
    onewire_bus_handle_t bus;
    std::uint64_t address;
};

esp_err_t onewire_new_device_iter(onewire_bus_handle_t, onewire_device_iter_handle_t*);
esp_err_t onewire_del_device_iter(onewire_device_iter_handle_t);
esp_err_t onewire_device_iter_get_next(onewire_device_iter_handle_t, onewire_device_t*);
