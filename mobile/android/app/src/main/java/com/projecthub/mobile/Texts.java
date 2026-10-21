package com.projecthub.mobile;

import android.content.Context;

/**
 * Строки интерфейса для чистых форматтеров (TASK-140.15): в приложении — ресурсы `strings.xml` текущей локали
 * (`values/` английский, `values-ru/` русский), в JVM-тесте — таблица из того же файла ресурсов. Так форматтеры
 * остаются без Android и проверяются тестом вместе с выбором ресурса.
 */
interface Texts {
    String get(int resId);

    static Texts of(Context ctx) {
        return ctx::getString;
    }
}
