"""
Audio chunk buffering system for LexiVoice STT.
Collects audio chunks per session/role and sends complete files to OpenAI.
"""

import base64
import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple


class AudioChunkBuffer:
    """Manages audio chunk buffering for a session/role."""
    
    # Buffer limits
    MAX_CHUNKS_BEFORE_PROCESS = 4  # Process after 4 chunks (~20 seconds at 5s/chunk)
    MAX_CHUNK_SIZE = 5 * 1024 * 1024  # 5MB per chunk
    MAX_BUFFER_AGE_SECONDS = 30  # Process if buffer older than 30s
    
    # Temp directory
    TEMP_BASE = "/tmp/lexivoice"
    
    def __init__(self, session_id: str, role: str):
        self.session_id = session_id
        self.role = role
        self.buffer_dir = Path(self.TEMP_BASE) / f"{session_id}_{role}"
        self.manifest_path = self.buffer_dir / "manifest.json"
        
        # Ensure buffer directory exists
        self.buffer_dir.mkdir(parents=True, exist_ok=True)
        logging.info("[audio-buffer] Initialized buffer: %s", self.buffer_dir)
    
    def add_chunk(self, audio_bytes: bytes, sequence_number: int, mime_type: str) -> Dict:
        """Add audio chunk to buffer."""
        
        # Validate chunk size
        if len(audio_bytes) > self.MAX_CHUNK_SIZE:
            raise ValueError(f"Chunk too large: {len(audio_bytes)} bytes")
        
        # Determine file extension
        if "webm" in mime_type:
            ext = ".webm"
        elif "ogg" in mime_type:
            ext = ".ogg"
        else:
            ext = ".webm"  # Default
        
        # Write chunk file
        chunk_path = self.buffer_dir / f"chunk_{sequence_number:04d}{ext}"
        chunk_path.write_bytes(audio_bytes)
        
        logging.info(
            "[audio-buffer] Wrote chunk %d: %s (%d bytes)",
            sequence_number, chunk_path.name, len(audio_bytes)
        )
        
        # Update manifest
        manifest = self._load_manifest()
        manifest["chunks"].append({
            "sequence": sequence_number,
            "filename": chunk_path.name,
            "size": len(audio_bytes),
            "timestamp": time.time()
        })
        manifest["mime_type"] = mime_type
        manifest["last_updated"] = time.time()
        self._save_manifest(manifest)
        
        return {
            "buffered_chunks": len(manifest["chunks"]),
            "total_size": sum(c["size"] for c in manifest["chunks"]),
            "oldest_chunk_age": time.time() - manifest["chunks"][0]["timestamp"] if manifest["chunks"] else 0
        }
    
    def should_process(self, is_final: bool) -> bool:
        """Check if buffer should be processed."""
        
        if is_final:
            return True
        
        manifest = self._load_manifest()
        chunk_count = len(manifest["chunks"])
        
        # Check chunk count
        if chunk_count >= self.MAX_CHUNKS_BEFORE_PROCESS:
            logging.info("[audio-buffer] Processing: chunk count %d >= %d", chunk_count, self.MAX_CHUNKS_BEFORE_PROCESS)
            return True
        
        # Check age
        if manifest["chunks"]:
            oldest_age = time.time() - manifest["chunks"][0]["timestamp"]
            if oldest_age >= self.MAX_BUFFER_AGE_SECONDS:
                logging.info("[audio-buffer] Processing: buffer age %.1fs >= %ds", oldest_age, self.MAX_BUFFER_AGE_SECONDS)
                return True
        
        return False
    
    def combine_chunks(self) -> Tuple[Path, str]:
        """Combine all buffered chunks into single file."""
        
        manifest = self._load_manifest()
        
        if not manifest["chunks"]:
            raise ValueError("No chunks to combine")
        
        # Sort chunks by sequence number
        sorted_chunks = sorted(manifest["chunks"], key=lambda c: c["sequence"])
        
        # Determine extension
        mime_type = manifest.get("mime_type", "audio/webm")
        if "webm" in mime_type:
            ext = ".webm"
        elif "ogg" in mime_type:
            ext = ".ogg"
        else:
            ext = ".webm"
        
        # Create combined file
        combined_path = self.buffer_dir / f"combined{ext}"
        
        logging.info("[audio-buffer] Combining %d chunks into %s", len(sorted_chunks), combined_path.name)
        
        with combined_path.open("wb") as combined_file:
            for chunk_info in sorted_chunks:
                chunk_path = self.buffer_dir / chunk_info["filename"]
                if chunk_path.exists():
                    chunk_data = chunk_path.read_bytes()
                    combined_file.write(chunk_data)
                    logging.info("[audio-buffer] Added chunk %s (%d bytes)", chunk_info["filename"], len(chunk_data))
                else:
                    logging.warning("[audio-buffer] Chunk not found: %s", chunk_path)
        
        combined_size = combined_path.stat().st_size
        logging.info("[audio-buffer] Combined file created: %s (%d bytes)", combined_path, combined_size)
        
        return combined_path, mime_type
    
    def cleanup(self, keep_manifest: bool = False):
        """Clean up buffer files."""
        
        try:
            # Delete chunk files
            for chunk_file in self.buffer_dir.glob("chunk_*"):
                chunk_file.unlink()
                logging.info("[audio-buffer] Deleted chunk: %s", chunk_file.name)
            
            # Delete combined file
            combined_files = list(self.buffer_dir.glob("combined.*"))
            for combined_file in combined_files:
                combined_file.unlink()
                logging.info("[audio-buffer] Deleted combined: %s", combined_file.name)
            
            # Delete manifest if requested
            if not keep_manifest and self.manifest_path.exists():
                self.manifest_path.unlink()
                logging.info("[audio-buffer] Deleted manifest")
            
            # Remove directory if empty
            if not keep_manifest and not list(self.buffer_dir.iterdir()):
                self.buffer_dir.rmdir()
                logging.info("[audio-buffer] Removed buffer directory")
        
        except Exception as error:
            logging.error("[audio-buffer] Cleanup failed: %s", str(error))
    
    def _load_manifest(self) -> Dict:
        """Load manifest file."""
        if self.manifest_path.exists():
            return json.loads(self.manifest_path.read_text())
        return {
            "session_id": self.session_id,
            "role": self.role,
            "chunks": [],
            "created": time.time(),
            "last_updated": time.time()
        }
    
    def _save_manifest(self, manifest: Dict):
        """Save manifest file."""
        self.manifest_path.write_text(json.dumps(manifest, indent=2))


def cleanup_old_buffers(max_age_seconds: int = 3600):
    """Clean up old buffer directories."""
    
    base_path = Path(AudioChunkBuffer.TEMP_BASE)
    if not base_path.exists():
        return
    
    cutoff_time = time.time() - max_age_seconds
    cleaned = 0
    
    for buffer_dir in base_path.iterdir():
        if not buffer_dir.is_dir():
            continue
        
        manifest_path = buffer_dir / "manifest.json"
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text())
                if manifest.get("last_updated", 0) < cutoff_time:
                    # Delete all files in directory
                    for file in buffer_dir.iterdir():
                        file.unlink()
                    buffer_dir.rmdir()
                    cleaned += 1
                    logging.info("[audio-buffer] Cleaned old buffer: %s", buffer_dir.name)
            except Exception as error:
                logging.error("[audio-buffer] Failed to clean %s: %s", buffer_dir.name, str(error))
    
    if cleaned > 0:
        logging.info("[audio-buffer] Cleaned %d old buffers", cleaned)
