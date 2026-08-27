<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import { ago, clock, thumbnail, type Recent } from '@/helpers/recents'

defineProps<{ items: Recent[]; offline: Set<string> }>()
defineEmits<{ (e: 'open', id: string): void; (e: 'forget', id: string): void }>()
</script>

<template>
  <ul class="grid">
    <li v-for="r in items" :key="r.id" class="card">
      <button class="open" :title="r.title || r.id" @click="$emit('open', r.id)">
        <span class="thumb">
          <img :src="thumbnail(r.id)" alt="" loading="lazy" decoding="async" />
          <!-- the audio is already here, so this one opens instantly -->
          <span v-if="offline.has(r.id)" class="badge" title="Audio is cached — opens instantly">
            <Icon name="wave" stroke />
          </span>
          <span v-if="clock(r.duration)" class="len">{{ clock(r.duration) }}</span>
        </span>
        <span class="meta">
          <span class="name">{{ r.title || r.id }}</span>
          <span class="when">{{ ago(r.at) }}</span>
        </span>
      </button>
      <button class="drop" aria-label="Remove from recents" title="Remove" @click.stop="$emit('forget', r.id)">
        <Icon name="close" stroke />
      </button>
    </li>
  </ul>
</template>

<style scoped>
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
}
.card { position: relative; }
.open {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 0;
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.thumb {
  position: relative;
  display: block;
  aspect-ratio: 16 / 9;
  border-radius: 9px;
  overflow: hidden;
  background: #141414;
  border: 1px solid #262626;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.open:hover .thumb { border-color: #e8bd6d; }
.badge {
  position: absolute;
  top: 6px;
  left: 6px;
  display: flex;
  padding: 3px 5px;
  border-radius: 5px;
  background: rgba(10, 10, 10, 0.82);
  color: #e8bd6d;
}
.len {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(10, 10, 10, 0.82);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #e6e6e6;
}
.meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name {
  font-size: 13px;
  line-height: 1.35;
  color: #e6e6e6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.when { font-size: 11px; color: #7c7c7c; }
.drop {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: rgba(10, 10, 10, 0.82);
  color: #cfcfcf;
  cursor: pointer;
  opacity: 0;
}
.card:hover .drop, .drop:focus-visible { opacity: 1; }
@media (hover: none) { .drop { opacity: 1; } }
</style>
