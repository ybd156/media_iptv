package com.mediaiptv.tv.ui.adapter

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.mediaiptv.tv.R
import com.mediaiptv.tv.databinding.ItemEpgBinding
import com.mediaiptv.tv.databinding.ItemEpgHeaderBinding
import com.mediaiptv.tv.model.Program

/**
 * EPG 节目单 Adapter：分「回看」与「直播 / 接下来」两区，支持七天节目表。
 * - 今天：已播完的进回看区，正在播与未播的进直播区
 * - 过去日期：全部进回看区
 * - **整份列表始终按时间正序**（回看区也从早到晚）：两个区连起来就是一条时间线，
 *   打开面板会自动滚到"正在看"那一行。原先回看区是倒序（新的在前），
 *   于是同一天里上半截从晚到早、下半截从早到晚 —— 用户反馈的"节目表排序不对"就是这个。
 * - 有录像可回看的：颜色鲜艳 + 右侧「回看」标记，可点击
 * - 不可回看的：暗淡
 * - 直播区右侧标记：正在看 / 接下来
 */
class EpgAdapter(
    private val onCatchupClick: (Program) -> Unit
) : ListAdapter<EpgAdapter.Row, RecyclerView.ViewHolder>(DIFF) {

    /** 行模型：分区标题或节目 */
    sealed class Row {
        data class Header(val title: String) : Row()
        data class Item(
            val program: Program,
            val tag: String,        // 右侧标记文本，空串不显示
            val colorRes: Int,      // 标题颜色资源
            val clickable: Boolean  // 是否可点击回看
        ) : Row()
    }

    /** 正在播出节目在当前列表中的位置（无则 -1），供打开面板时定位 */
    var currentRowIndex: Int = -1
        private set

    /**
     * 用节目列表重建分区结构。
     * @param nowSec    当前时间 "HH:mm:ss"
     * @param dayOffset 日期偏移：0=今天，<0=过去（全部回看），>0=未来（预告，不可回看）
     */
    fun submitPrograms(
        programs: List<Program>,
        nowSec: String,
        dayOffset: Int,
        replayTitle: String,
        liveTitle: String,
        previewTitle: String,
        tagNow: String,
        tagNext: String,
        tagReplay: String
    ) {
        val rows = mutableListOf<Row>()
        currentRowIndex = -1

        val replayRows = { list: List<Program> ->
            list.map { p ->
                if (p.hasRecord) Row.Item(p, tagReplay, R.color.record_highlight, true)
                else Row.Item(p, "", R.color.text_hint, false)
            }
        }

        when {
            dayOffset > 0 -> {
                // 未来日期：全部进预告区，标记"接下来"，不可点击
                if (programs.isNotEmpty()) {
                    rows.add(Row.Header(previewTitle))
                    programs.forEach { p ->
                        rows.add(Row.Item(p, tagNext, R.color.text_primary, false))
                    }
                }
            }
            dayOffset == 0 -> {
                // 一次遍历分成"已播/在播及未来"两组，避免两次 filter
                // 两组都保持**时间正序**：整份列表从早到晚一条线（见类注释）
                val past = ArrayList<Program>(programs.size)
                val live = ArrayList<Program>(programs.size)
                for (p in programs) {
                    // **跨零点的节目**（如 23:28-01:09）end 比 start 小，直接拿 end 和现在比
                    // 会把它当成"已经播完"，于是被塞进回看区的最前面 —— 用户反馈的
                    // "回看顺序不对"就是这个：中间会冒出一条 23:28-01:09。
                    // 跨零点的节目今天只可能"还没开始"或"正在播"，不可能是过去。
                    if (!crossesMidnight(p) && p.end <= nowSec) past.add(p) else live.add(p)
                }
                if (past.isNotEmpty()) {
                    rows.add(Row.Header(replayTitle))
                    rows.addAll(replayRows(past))
                }
                if (live.isNotEmpty()) {
                    rows.add(Row.Header(liveTitle))
                    live.forEach { p ->
                        val isNow = if (crossesMidnight(p)) p.start <= nowSec
                        else p.start <= nowSec && p.end > nowSec
                        if (isNow && currentRowIndex < 0) currentRowIndex = rows.size
                        rows.add(
                            if (isNow) Row.Item(p, tagNow, R.color.text_primary, false)
                            else Row.Item(p, tagNext, R.color.text_primary, false)
                        )
                    }
                }
            }
            else -> {
                if (programs.isNotEmpty()) {
                    rows.add(Row.Header(replayTitle))
                    rows.addAll(replayRows(programs))
                }
            }
        }
        submitList(rows)
    }

    override fun getItemViewType(position: Int): Int =
        when (getItem(position)) {
            is Row.Header -> TYPE_HEADER
            is Row.Item -> TYPE_PROGRAM
        }

    inner class HeaderVH(binding: ItemEpgHeaderBinding) : RecyclerView.ViewHolder(binding.root)

    inner class ProgramVH(val binding: ItemEpgBinding) : RecyclerView.ViewHolder(binding.root) {
        init {
            binding.root.setOnClickListener {
                val pos = bindingAdapterPosition
                if (pos != RecyclerView.NO_POSITION) {
                    val row = getItem(pos)
                    if (row is Row.Item && row.clickable) onCatchupClick(row.program)
                }
            }
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return if (viewType == TYPE_HEADER) {
            HeaderVH(ItemEpgHeaderBinding.inflate(inflater, parent, false))
        } else {
            ProgramVH(ItemEpgBinding.inflate(inflater, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val row = getItem(position)) {
            is Row.Header -> ((holder as HeaderVH).itemView as? TextView)?.text = row.title
            is Row.Item -> {
                val program = row.program
                val ctx = holder.itemView.context
                (holder as ProgramVH).binding.tvTime.text =
                    "${program.start.take(5)} - ${program.end.take(5)}"
                holder.binding.tvTitle.text = program.title
                holder.binding.tvTitle.setTextColor(colorOf(ctx, row.colorRes))
                holder.binding.tvTime.setTextColor(
                    colorOf(ctx, if (row.clickable) R.color.record_highlight else R.color.text_hint)
                )
                if (row.tag.isEmpty()) {
                    holder.binding.tvTag.visibility = View.GONE
                } else {
                    holder.binding.tvTag.visibility = View.VISIBLE
                    holder.binding.tvTag.text = row.tag
                    holder.binding.tvTag.setTextColor(
                        colorOf(ctx, if (row.clickable) R.color.record_highlight else R.color.primary)
                    )
                }
            }
        }
    }

    /**
     * 颜色资源解析缓存。
     * ContextCompat.getColor 每次都要走 Resources 查询，而 onBindViewHolder 里原先有 3~4 次。
     */
    private val colorCache = HashMap<Int, Int>()

    private fun colorOf(context: android.content.Context, resId: Int): Int =
        colorCache.getOrPut(resId) { ContextCompat.getColor(context, resId) }

    /** 节目是否跨零点（end 比 start 小，如 23:28-01:09）：end 在第二天 */
    private fun crossesMidnight(p: Program): Boolean = p.end <= p.start

    companion object {
        private const val TYPE_HEADER = 0
        private const val TYPE_PROGRAM = 1

        private val DIFF = object : DiffUtil.ItemCallback<Row>() {
            override fun areItemsTheSame(a: Row, b: Row): Boolean = when {
                a is Row.Header && b is Row.Header -> a.title == b.title
                a is Row.Item && b is Row.Item ->
                    a.program.start == b.program.start && a.program.title == b.program.title
                else -> false
            }
            override fun areContentsTheSame(a: Row, b: Row) = a == b
        }
    }
}
