package com.mediaiptv.tv.ui.adapter

import android.graphics.drawable.GradientDrawable
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.DataSource
import com.bumptech.glide.load.engine.GlideException
import com.bumptech.glide.request.RequestListener
import com.bumptech.glide.request.target.Target
import com.mediaiptv.tv.R
import com.mediaiptv.tv.databinding.ItemChannelBinding
import com.mediaiptv.tv.model.Channel

/**
 * 频道列表 Adapter：显示台标、频道名、当前节目名。
 * 台标为空或加载失败时用频道名首字 + 按频道 id 取色的圆形文字兜底。
 * 通过 [currentChannelId] 高亮当前播放项。
 */
class ChannelAdapter(
    private val onClick: (Channel) -> Unit,
    private val onLongClick: ((Channel) -> Unit)? = null,
    /**
     * 遥控器/方向键滚动时焦点落到该项即回调（无需按 OK）。
     * 外层据此实现"到哪播哪"。绑定/回收造成的假焦点由外层按 currentChannelId 去重。
     */
    private val onFocus: ((Channel) -> Unit)? = null
) : ListAdapter<Channel, ChannelAdapter.VH>(DIFF) {

    /** 当前正在播放的频道 id（用于高亮） */
    var currentChannelId: Int = -1
        set(value) {
            if (field == value) return
            val old = field
            field = value
            // 局部刷新：只通知可能变化的两个项
            currentList.forEachIndexed { idx, ch ->
                if (ch.id == old || ch.id == value) notifyItemChanged(idx)
            }
        }

    /** 当前播放频道对应的 EPG 节目名（更新后刷新整行） */
    private var currentProgramTitle: String = ""

    /** 全频道正在播出：channelId -> 节目标题 */
    private var nowPlaying: Map<Int, String> = emptyMap()

    fun updateCurrentProgram(title: String) {
        if (title == currentProgramTitle) return
        currentProgramTitle = title
        // 只刷新当前频道那一行
        val idx = currentList.indexOfFirst { it.id == currentChannelId }
        if (idx >= 0) notifyItemChanged(idx)
    }

    /** 全频道正在播出更新（服务端 EPG 同步后客户端每 10 分钟拉一次） */
    fun submitNowPlaying(map: Map<Int, String>) {
        val old = nowPlaying
        nowPlaying = map
        // 只刷新标题真正变化的行。原先无条件 notifyItemRangeChanged(0, size)，
        // 会让所有可见行重新 bind —— 每次都重建兜底 Drawable 并重新发起 Glide 请求。
        currentList.forEachIndexed { idx, ch ->
            if (old[ch.id] != map[ch.id]) notifyItemChanged(idx)
        }
    }

    inner class VH(val binding: ItemChannelBinding) : RecyclerView.ViewHolder(binding.root) {

        /**
         * Glide 回调在 ViewHolder 上创建一次即可（原先每次 bind 都新建一个匿名对象）。
         * 放在 holder 上而不是全局共享：回调需要写入本行的兜底文字层，共享实例在视图
         * 复用时可能写到错误的行。
         */
        val logoListener = object : RequestListener<android.graphics.drawable.Drawable> {
            override fun onLoadFailed(
                e: GlideException?, model: Any?,
                target: Target<android.graphics.drawable.Drawable>, isFirstResource: Boolean
            ): Boolean {
                binding.ivLogo.setImageDrawable(null) // 露出文字兜底
                return true
            }

            override fun onResourceReady(
                resource: android.graphics.drawable.Drawable, model: Any,
                target: Target<android.graphics.drawable.Drawable>,
                dataSource: DataSource, isFirstResource: Boolean
            ): Boolean {
                binding.tvLogoFallback.visibility = android.view.View.INVISIBLE
                return false
            }
        }

        init {
            binding.root.setOnClickListener {
                val pos = bindingAdapterPosition
                if (pos != RecyclerView.NO_POSITION) onClick(getItem(pos))
            }
            // 长按 → 线路切换（触屏等效遥控器长按 OK）
            binding.root.setOnLongClickListener {
                val pos = bindingAdapterPosition
                if (pos != RecyclerView.NO_POSITION) {
                    onLongClick?.invoke(getItem(pos))
                    true
                } else false
            }
            // 焦点到达即选中：方向键滚动列表时直接播放对应频道
            binding.root.onFocusChangeListener = android.view.View.OnFocusChangeListener { _, hasFocus ->
                if (hasFocus) {
                    val pos = bindingAdapterPosition
                    if (pos != RecyclerView.NO_POSITION) onFocus?.invoke(getItem(pos))
                }
            }
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val binding = ItemChannelBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return VH(binding)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val channel = getItem(position)
        val isCurrent = channel.id == currentChannelId
        val playable = channel.urls.isNotEmpty()

        holder.binding.tvChannelName.text = channel.name
        val nowTitle = nowPlaying[channel.id]
        holder.binding.tvProgramTitle.text = when {
            !playable -> "暂无可用线路"
            isCurrent && currentProgramTitle.isNotEmpty() -> currentProgramTitle
            nowTitle != null -> nowTitle
            else -> holder.itemView.context.getString(R.string.no_program)
        }
        // 无可用线路的占位频道整体置灰，提示不可播放（换台键会自动跳过）
        holder.itemView.alpha = if (playable) 1f else 0.45f

        holder.binding.root.isSelected = isCurrent

        // 台标：文字兜底常驻底层，图片加载成功后盖住；失败则清掉图片露出文字。
        // 兜底背景复用预建的 6 个 Drawable（原先每次 bind 都 new 一个 GradientDrawable）。
        val fallback = holder.binding.tvLogoFallback
        fallback.visibility = android.view.View.VISIBLE
        fallback.text = channel.name.take(2)
        fallback.background = logoDrawableFor(channel.id)
        val image = holder.binding.ivLogo
        if (channel.logo.isNullOrBlank()) {
            Glide.with(image).clear(image)
            image.setImageDrawable(null)
        } else {
            Glide.with(image)
                .load(channel.logo)
                .override(128, 128)
                .listener(holder.logoListener)
                .into(image)
        }
    }

    companion object {
        /** 台标兜底配色（按频道 id 轮换，深色底保证白字可读） */
        private val LOGO_COLORS = intArrayOf(
            0xFF2B4C7E.toInt(), 0xFF567D46.toInt(), 0xFF8C5B2A.toInt(),
            0xFF7A3B69.toInt(), 0xFF3B6E7A.toInt(), 0xFF8C3A3A.toInt(),
        )

        /**
         * 预建的圆形兜底背景。
         * 这 6 个 Drawable 创建后不再改动（不 setColor），因此可以安全地在多行之间共享；
         * 每次 bind 只是重新赋值，省掉一次对象分配。
         */
        private val LOGO_DRAWABLES: Array<GradientDrawable> = Array(LOGO_COLORS.size) { i ->
            GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(LOGO_COLORS[i])
            }
        }

        private fun logoDrawableFor(channelId: Int): GradientDrawable {
            val n = LOGO_DRAWABLES.size
            return LOGO_DRAWABLES[((channelId % n) + n) % n]
        }

        private val DIFF = object : DiffUtil.ItemCallback<Channel>() {
            override fun areItemsTheSame(a: Channel, b: Channel) = a.id == b.id
            override fun areContentsTheSame(a: Channel, b: Channel) = a == b
        }
    }
}
