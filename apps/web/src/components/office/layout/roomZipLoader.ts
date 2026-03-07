/**
 * Loads a tileEditor room.zip and converts it to an OfficeLayout
 * with a background image and custom furniture sprites.
 *
 * The grid is downsampled by a factor of 2 (e.g. 64×64 → 32×32)
 * so that characters remain a reasonable size at the game's zoom level.
 */

import JSZip from 'jszip'
import type { OfficeLayout, PlacedFurniture, SpriteData, FloorColor, TileType as TileTypeVal } from '../types'
import { TileType, TILE_SIZE } from '../types'
import { registerCustomSprites } from './furnitureCatalog'

const PNG_ALPHA_THRESHOLD = 128
const DOWNSAMPLE_FACTOR = 2

interface RoomJson {
  version: number
  name: string
  cellSize: number
  cols: number
  rows: number
  backgroundWidth: number
  backgroundHeight: number
  backgroundFile?: string
  tiles: number[]
  tileset?: Array<{
    id: string
    name: string
    file: string
    gridW: number
    gridH: number
    tag?: string
  }>
  furniture?: Array<{
    uid: string
    tileId: string
    name: string
    col: number
    row: number
    widthCells: number
    heightCells: number
  }>
}

export interface RoomZipResult {
  layout: OfficeLayout
  backgroundImage: HTMLImageElement | null
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image from blob'))
    }
    img.src = url
  })
}

/**
 * Convert an image to SpriteData, scaling to a target size.
 */
function imageToSpriteData(img: HTMLImageElement, targetW: number, targetH: number): SpriteData {
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, 0, 0, targetW, targetH)
  const imageData = ctx.getImageData(0, 0, targetW, targetH)
  const { data } = imageData

  const sprite: SpriteData = []
  for (let y = 0; y < targetH; y++) {
    const row: string[] = []
    for (let x = 0; x < targetW; x++) {
      const idx = (y * targetW + x) * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const a = data[idx + 3]
      if (a < PNG_ALPHA_THRESHOLD) {
        row.push('')
      } else {
        row.push(
          `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase(),
        )
      }
    }
    sprite.push(row)
  }
  return sprite
}

function mimeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

/** Map tileEditor cell types to bit-office TileType */
function mapTileType(cell: number): number {
  if (cell === 0) return TileType.WALL
  if (cell === 8) return TileType.VOID
  if (cell >= 1 && cell <= 7) return cell
  return TileType.FLOOR_1
}

/**
 * Downsample a tile grid by merging NxN blocks into single tiles.
 * Uses majority vote: WALL > VOID > FLOOR (prioritize blocking tiles).
 */
function downsampleTiles(
  srcTiles: number[],
  srcCols: number,
  srcRows: number,
  factor: number,
): { tiles: number[]; cols: number; rows: number } {
  const cols = Math.floor(srcCols / factor)
  const rows = Math.floor(srcRows / factor)
  const tiles: number[] = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let wallCount = 0
      let voidCount = 0
      let floorCount = 0
      for (let dr = 0; dr < factor; dr++) {
        for (let dc = 0; dc < factor; dc++) {
          const srcR = r * factor + dr
          const srcC = c * factor + dc
          const t = srcTiles[srcR * srcCols + srcC]
          if (t === TileType.WALL) wallCount++
          else if (t === TileType.VOID) voidCount++
          else floorCount++
        }
      }
      const total = factor * factor
      // If majority is wall → wall, if majority void → void, else floor
      if (wallCount > total / 2) tiles.push(TileType.WALL)
      else if (voidCount > total / 2) tiles.push(TileType.VOID)
      else tiles.push(TileType.FLOOR_1)
    }
  }

  return { tiles, cols, rows }
}

export async function loadRoomZip(file: File): Promise<RoomZipResult | null> {
  const zip = await JSZip.loadAsync(file)

  const roomJsonFile = zip.file('room.json')
  if (!roomJsonFile) {
    alert('Invalid room zip: missing room.json')
    return null
  }

  const roomJson: RoomJson = JSON.parse(await roomJsonFile.async('text'))
  if (!roomJson.cols || !roomJson.rows || !roomJson.tiles) {
    alert('Invalid room.json: missing cols/rows/tiles')
    return null
  }

  // 1. Load background image
  let backgroundImage: HTMLImageElement | null = null
  if (roomJson.backgroundFile) {
    const bgFile = zip.file(roomJson.backgroundFile)
    if (bgFile) {
      const ab = await bgFile.async('arraybuffer')
      const blob = new Blob([ab], { type: mimeFromFilename(roomJson.backgroundFile) })
      backgroundImage = await loadImageFromBlob(blob)
    }
  }

  // 2. Load tileset sprites and register them as custom furniture
  const customSprites = new Map<string, { sprite: SpriteData; footprintW: number; footprintH: number; label: string }>()

  if (roomJson.tileset) {
    for (const tile of roomJson.tileset) {
      if (!tile.file) continue
      const tileFile = zip.file(tile.file)
      if (!tileFile) continue
      const ab = await tileFile.async('arraybuffer')
      const blob = new Blob([ab], { type: mimeFromFilename(tile.file) })
      const img = await loadImageFromBlob(blob)
      // Footprint after downsampling
      const dsW = Math.max(1, Math.round(tile.gridW / DOWNSAMPLE_FACTOR))
      const dsH = Math.max(1, Math.round(tile.gridH / DOWNSAMPLE_FACTOR))
      // Scale sprite to match downsampled tile grid
      const targetW = dsW * TILE_SIZE
      const targetH = dsH * TILE_SIZE
      const sprite = imageToSpriteData(img, targetW, targetH)
      customSprites.set(`room-${tile.id}`, {
        sprite,
        footprintW: dsW,
        footprintH: dsH,
        label: tile.name,
      })
    }
    if (customSprites.size > 0) {
      registerCustomSprites(customSprites)
    }
  }

  // 3. Map tile types then downsample the grid
  const mappedTiles = roomJson.tiles.map(mapTileType)
  const ds = downsampleTiles(mappedTiles, roomJson.cols, roomJson.rows, DOWNSAMPLE_FACTOR)

  // 4. Generate default tileColors for floor tiles
  const defaultFloorColor: FloorColor = { h: 35, s: 30, b: 15, c: 0 }
  const tileColors: Array<FloorColor | null> = ds.tiles.map((t) =>
    t === TileType.WALL || t === TileType.VOID ? null : defaultFloorColor,
  )

  // 5. Map furniture with downsampled positions
  const furniture: PlacedFurniture[] = (roomJson.furniture || []).map((f) => ({
    uid: f.uid,
    type: `room-${f.tileId}`,
    col: Math.round(f.col / DOWNSAMPLE_FACTOR),
    row: Math.round(f.row / DOWNSAMPLE_FACTOR),
  }))

  const layout: OfficeLayout = {
    version: 1,
    cols: ds.cols,
    rows: ds.rows,
    tiles: ds.tiles as TileTypeVal[],
    furniture,
    tileColors,
  }

  return { layout, backgroundImage }
}
