package com.mediaiptv.tv.ui.settings

import android.app.AlertDialog
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.WindowManager
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.mediaiptv.tv.BuildConfig
import com.mediaiptv.tv.R
import com.mediaiptv.tv.databinding.ActivitySettingsBinding
import com.mediaiptv.tv.service.KeepAlive
import com.mediaiptv.tv.update.UpdateDialogs
import com.mediaiptv.tv.util.Prefs

/**
 * 设置侧边面板（约占屏幕右侧 1/4 宽）：
 * 全部选项为遥控器友好的行式列表（上下移动焦点，OK 循环切换或弹窗输入），
 * 不使用 RadioGroup/EditText 内联输入，避免方向键被控件吞掉导致焦点锁死。
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding

    /** 行视图引用：标题 -> (值控件, 值提供器)，切换后刷新显示 */
    private val rowUpdaters = mutableListOf<() -> Unit>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 浮窗：靠右侧，宽约屏幕 28%（不小于 400dp），高度撑满
        val density = resources.displayMetrics.density
        val width = maxOf((resources.displayMetrics.widthPixels * 0.28f).toInt(), (400 * density).toInt())
        window?.apply {
            setLayout(width, WindowManager.LayoutParams.MATCH_PARENT)
            attributes = attributes?.apply { gravity = Gravity.END or Gravity.TOP }
        }

        buildRows()
        binding.tvVersion.text = "${getString(R.string.settings_version)} ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"
    }

    /**
     * 回到设置页时刷新所有行的值。
     * 有些行点击后会跳到系统页面（电池优化豁免、安装未知应用授权），
     * 用户改完回来必须看到新状态，否则会以为没生效。
     */
    override fun onResume() {
        super.onResume()
        rowUpdaters.forEach { it() }
    }

    /** 返回键直接退出设置（不弹确认、不拦截） */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        finish()
    }

    // ============================ 行构造 ============================

    private fun buildRows() {
        // ------------------------- 播放 -------------------------
        addGroupHeader(getString(R.string.settings_group_play))

        // 播放内核（Exo / 系统 / IJK 兼容）
        addCycleRow(
            getString(R.string.settings_engine),
            listOf(Prefs.ENGINE_EXO to getString(R.string.settings_engine_exo),
                   Prefs.ENGINE_SYSTEM to getString(R.string.settings_engine_system),
                   Prefs.ENGINE_IJK to getString(R.string.settings_engine_ijk)),
            { Prefs.getEngine(this) },
            { Prefs.setEngine(this, it) }
        )

        // 视频解码模式（自动/硬解/软解）
        addCycleRow(
            getString(R.string.settings_video_decode_short),
            listOf(Prefs.DECODE_AUTO to getString(R.string.settings_decode_auto),
                   Prefs.DECODE_HW to getString(R.string.settings_decode_hw),
                   Prefs.DECODE_SW to getString(R.string.settings_decode_sw)),
            { Prefs.getVideoDecodeMode(this) },
            { Prefs.setVideoDecodeMode(this, it) }
        )

        // 音频解码模式（自动/硬解/软解）
        addCycleRow(
            getString(R.string.settings_audio_decode_short),
            listOf(Prefs.DECODE_AUTO to getString(R.string.settings_decode_auto),
                   Prefs.DECODE_HW to getString(R.string.settings_decode_hw),
                   Prefs.DECODE_SW to getString(R.string.settings_decode_sw)),
            { Prefs.getAudioDecodeMode(this) },
            { Prefs.setAudioDecodeMode(this, it) }
        )

        // 音频直通：AC3/E-AC3/DTS 原样输出，由电视/功放解码（解决盒子解不了 AC3 无声）
        addCycleRow(
            getString(R.string.settings_audio_passthrough),
            listOf(false to getString(R.string.off), true to getString(R.string.on)),
            { Prefs.getAudioPassthrough(this) },
            { Prefs.setAudioPassthrough(this, it) }
        )

        // ------------------------- 画面 -------------------------
        addGroupHeader(getString(R.string.settings_group_picture))

        // 画面比例（切完立即生效，无需返回主页）
        addCycleRow(
            getString(R.string.settings_scale),
            listOf(Prefs.SCALE_FIT to getString(R.string.settings_scale_fit),
                   Prefs.SCALE_FILL to getString(R.string.settings_scale_fill),
                   Prefs.SCALE_ZOOM to getString(R.string.settings_scale_zoom),
                   Prefs.SCALE_169 to getString(R.string.settings_scale_169)),
            { Prefs.getScaleMode(this) },
            {
                Prefs.setScaleMode(this, it)
                // 通知播放页立即应用新比例
                com.mediaiptv.tv.ui.player.MainActivity.onScaleModeChanged?.invoke(it)
            }
        )

        // 画质偏好
        addCycleRow(
            getString(R.string.settings_quality_short),
            listOf(Prefs.QUALITY_AUTO to getString(R.string.settings_quality_auto),
                   Prefs.QUALITY_HIGH to getString(R.string.settings_quality_high),
                   Prefs.QUALITY_LOW to getString(R.string.settings_quality_low)),
            { Prefs.getQuality(this) },
            { Prefs.setQuality(this, it) }
        )

        // OSD 底部统计行开关
        addCycleRow(
            getString(R.string.settings_osd_stats),
            listOf(true to getString(R.string.on), false to getString(R.string.off)),
            { Prefs.getOsdStats(this) },
            { Prefs.setOsdStats(this, it) }
        )

        // OSD 统计刷新间隔（越小越实时，越耗性能）
        addCycleRow(
            getString(R.string.settings_osd_stats_interval),
            listOf(500, 1000, 2000).map {
                it to getString(R.string.settings_osd_stats_interval_fmt, it)
            },
            { Prefs.getOsdStatsIntervalMs(this) },
            { Prefs.setOsdStatsIntervalMs(this, it) }
        )

        // 播放时强制不息屏
        addCycleRow(
            getString(R.string.settings_keep_screen_on),
            listOf(true to getString(R.string.on), false to getString(R.string.off)),
            { Prefs.getKeepScreenOn(this) },
            { Prefs.setKeepScreenOn(this, it) }
        )

        // ------------------------- 网络 -------------------------
        addGroupHeader(getString(R.string.settings_group_network))

        // 缓冲档位
        addCycleRow(
            getString(R.string.settings_buffer),
            listOf(0 to getString(R.string.settings_buffer_low),
                   1 to getString(R.string.settings_buffer_mid),
                   2 to getString(R.string.settings_buffer_high)),
            { Prefs.getBufferLevel(this) },
            { Prefs.setBufferLevel(this, it) }
        )

        // 超时自动换源开关：播放 X 秒不出画面自动换下一条线路
        addCycleRow(
            getString(R.string.settings_auto_switch),
            listOf(true to getString(R.string.on), false to getString(R.string.off)),
            { Prefs.getAutoSwitchSource(this) },
            { Prefs.setAutoSwitchSource(this, it) }
        )

        // 换源等待时长
        addCycleRow(
            getString(R.string.settings_switch_timeout),
            listOf(5, 10, 15, 20, 30).map { it to getString(R.string.settings_switch_timeout_fmt, it) },
            { Prefs.getSwitchTimeoutSec(this) },
            { Prefs.setSwitchTimeoutSec(this, it) }
        )

        // ------------------------- 系统 -------------------------
        addGroupHeader(getString(R.string.settings_group_system))

        // 服务器地址：OK 弹输入框
        addRow(
            getString(R.string.settings_server),
            { Prefs.getServerUrl(this) }
        ) {
            showServerInputDialog()
        }

        // 开机自启
        addCycleRow(
            getString(R.string.settings_autostart),
            listOf(false to getString(R.string.off), true to getString(R.string.on)),
            { Prefs.getAutostart(this) },
            { enabled ->
                Prefs.setAutostart(this, enabled)
                if (enabled) {
                    Toast.makeText(this, R.string.autostart_hint, Toast.LENGTH_LONG).show()
                }
            }
        )

        // 后台保活：常驻前台服务 + 被系统回收后自恢复。
        // 注意顺序：先写 pref 再启停服务 —— KeepAliveService.onDestroy 会读这个 pref
        // 决定要不要排重启闹钟，顺序反了会出现「关掉之后又自己起来」。
        addCycleRow(
            getString(R.string.settings_keepalive),
            listOf(false to getString(R.string.off), true to getString(R.string.on)),
            { Prefs.getKeepAlive(this) },
            { enabled ->
                Prefs.setKeepAlive(this, enabled)
                if (enabled) {
                    KeepAlive.ensure(this)
                    KeepAlive.requestNotificationPermission(this)
                    Toast.makeText(this, R.string.settings_keepalive_hint, Toast.LENGTH_LONG).show()
                } else {
                    KeepAlive.stop(this)
                }
            }
        )

        // 时移是**服务端**能力，客户端不再有自己的开关：
        // 服务端开了就有进度条、没开就没有入口，避免两边各说各话。

        // 忽略电池优化：Android 6.0+ 息屏后 Doze 会限制后台，豁免之后常驻才真正稳
        addRow(
            getString(R.string.settings_battery),
            {
                if (KeepAlive.isIgnoringBatteryOptimizations(this)) {
                    getString(R.string.settings_battery_done)
                } else {
                    getString(R.string.settings_battery_todo)
                }
            }
        ) {
            KeepAlive.requestIgnoreBatteryOptimizations(this)
        }

        // 解码器检测
        addRow(getString(R.string.settings_codec_detect), { "" }) {
            binding.tvCodecInfo.text = detectCodecs()
            binding.tvCodecInfo.visibility = android.view.View.VISIBLE
        }

        // 检查更新：结果（检查中 / 已是最新 / 没有更新包 / 失败）显示在行右侧。
        // 手动检查永远显示结果——哪怕用户之前点过「稍后」，也不该点了没反应。
        var updateStatus = ""
        addRow(getString(R.string.update_check), { updateStatus }) {
            UpdateDialogs.checkManually(this, lifecycleScope) { status ->
                updateStatus = status
                rowUpdaters.forEach { it() }
            }
        }

        // 设备 ID（只读，不可聚焦）
        addInfoRow(getString(R.string.settings_device_id), Prefs.getDeviceId(this))
    }

    /** 分组小标题（不可聚焦，纯展示，不参与遥控器焦点导航） */
    private fun addGroupHeader(title: String) {
        val density = resources.displayMetrics.density
        val tv = TextView(this).apply {
            text = title
            setTextColor(androidx.core.content.ContextCompat.getColor(this@SettingsActivity, R.color.text_hint))
            textSize = 14f
            isFocusable = false
            setPadding(
                (16 * density).toInt(),
                (24 * density).toInt(),
                (16 * density).toInt(),
                (6 * density).toInt()
            )
        }
        binding.settingsRows.addView(tv)
    }

    /** 添加可聚焦行：OK 触发 onClick，值由 valueProvider 提供 */
    private fun addRow(title: String, valueProvider: () -> String, onClick: () -> Unit) {
        val row = LayoutInflater.from(this).inflate(R.layout.item_settings_row, binding.settingsRows, false)
        val tvTitle = row.findViewById<TextView>(R.id.tvRowTitle)
        val tvValue = row.findViewById<TextView>(R.id.tvRowValue)
        tvTitle.text = title
        val updater = { tvValue.text = valueProvider() }
        updater()
        rowUpdaters.add(updater)
        row.setOnClickListener {
            onClick()
            rowUpdaters.forEach { it() }
        }
        binding.settingsRows.addView(row)
    }

    /** 循环选项行：OK 切到下一个值 */
    private fun <T> addCycleRow(
        title: String,
        options: List<Pair<T, String>>,
        getter: () -> T,
        setter: (T) -> Unit
    ) {
        addRow(title, { options.firstOrNull { it.first == getter() }?.second ?: "" }) {
            val idx = options.indexOfFirst { it.first == getter() }
            val next = options[(idx + 1) % options.size]
            setter(next.first)
        }
    }

    /** 只读信息行（不可聚焦，不吞遥控器按键） */
    private fun addInfoRow(title: String, value: String) {
        val row = LayoutInflater.from(this).inflate(R.layout.item_settings_row, binding.settingsRows, false)
        row.isFocusable = false
        row.findViewById<TextView>(R.id.tvRowTitle).text = title
        row.findViewById<TextView>(R.id.tvRowValue).text = value
        binding.settingsRows.addView(row)
    }

    /** 服务器地址输入弹窗（对话框内 EditText 不影响主面板焦点导航） */
    private fun showServerInputDialog() {
        val input = EditText(this).apply {
            setText(Prefs.getServerUrl(this@SettingsActivity))
            setSingleLine(true)
            setPadding(32, 24, 32, 24)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.settings_server)
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val url = input.text.toString().trim()
                if (url.isNotEmpty()) {
                    Prefs.setServerUrl(this, url)
                    // 保存后立即刷新行显示（否则界面显示旧值，误以为没保存）
                    rowUpdaters.forEach { it() }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** 枚举设备支持的视频解码器（硬解/软解标注） */
    private fun detectCodecs(): String {
        val mimeTypes = listOf(
            "video/avc" to "H.264",
            "video/hevc" to "H.265/HEVC",
            "video/av01" to "AV1",
            "video/x-vnd.on2.vp9" to "VP9",
            "video/mp4v-es" to "MPEG-4",
            "audio/mp4a-latm" to "AAC"
        )
        val sb = StringBuilder()
        val list = android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS)
        val decoders = list.codecInfos.filter { !it.isEncoder }
        for ((mime, label) in mimeTypes) {
            val matched = decoders.filter { ci -> ci.supportedTypes.any { it.equals(mime, true) } }
            if (matched.isEmpty()) {
                sb.append("✗ $label：不支持\n")
            } else {
                for (ci in matched) {
                    val hw = if (android.os.Build.VERSION.SDK_INT >= 29) ci.isHardwareAccelerated
                             else !ci.name.startsWith("OMX.google") && !ci.name.startsWith("c2.android")
                    sb.append(if (hw) "● $label：${ci.name}（硬解）\n" else "○ $label：${ci.name}（软解）\n")
                }
            }
        }
        return sb.toString().trimEnd()
    }
}
