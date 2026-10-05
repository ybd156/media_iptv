package com.mediaiptv.tv.ui.adapter

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.mediaiptv.tv.R
import com.mediaiptv.tv.databinding.ItemGroupBinding
import com.mediaiptv.tv.model.ChannelGroup

/**
 * 分组 Tab 列表 Adapter（左侧）。
 * DPad 焦点由系统提供；选中高亮由 selectedPosition 控制。
 */
class GroupAdapter(
    private val onSelected: (ChannelGroup) -> Unit
) : ListAdapter<ChannelGroup, GroupAdapter.VH>(DIFF) {

    private var selectedPosition: Int = 0

    fun setSelectedPosition(pos: Int) {
        if (pos == selectedPosition) return
        val old = selectedPosition
        selectedPosition = pos
        notifyItemChanged(old)
        notifyItemChanged(pos)
    }

    inner class VH(val binding: ItemGroupBinding) : RecyclerView.ViewHolder(binding.root) {
        init {
            // 仅点击（OK键）切换分组；不在焦点变化时联动——
            // 焦点监听在列表 rebind 期间会拿到过期的 bindingAdapterPosition，
            // 导致高亮分组与右侧频道列表内容错位
            binding.root.setOnClickListener {
                val pos = bindingAdapterPosition
                if (pos != RecyclerView.NO_POSITION) {
                    setSelectedPosition(pos)
                    onSelected(getItem(pos))
                }
            }
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val binding = ItemGroupBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return VH(binding)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val item = getItem(position)
        holder.binding.tvGroupName.text = item.name
        holder.binding.root.isSelected = position == selectedPosition
    }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<ChannelGroup>() {
            override fun areItemsTheSame(a: ChannelGroup, b: ChannelGroup) = a.id == b.id
            override fun areContentsTheSame(a: ChannelGroup, b: ChannelGroup) = a == b
        }
    }
}
