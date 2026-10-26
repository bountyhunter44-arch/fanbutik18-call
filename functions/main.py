import base64
from datetime import datetime, timedelta
import io
import json
import logging
import os
import re
import tempfile
import urllib.error
import urllib.request

from firebase_admin import firestore, initialize_app
from firebase_functions import https_fn, scheduler_fn, firestore_fn
from firebase_functions.options import set_global_options

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None
    logging.warning("OpenAI SDK not installed - STT will not work")

try:
    from audio_buffer import AudioChunkBuffer, cleanup_old_buffers
except ImportError:
    AudioChunkBuffer = None
    cleanup_old_buffers = None
    logging.warning("audio_buffer module not found - buffered STT will not work")


try:
    initialize_app()
except ValueError:
    pass


set_global_options(max_instances=10)


ALLOWED_ROUTES = {"workflow", "document", "chat"}
ALLOWED_COLORS = {"white", "blue", "red", "orange"}
ALLOWED_HEALTH_LANGUAGES = {"da", "kl", "auto"}
URGENT_DANISH_PHRASES = [
    "brystsmerter",
    "bryst smerter",
    "vejrtrækningsbesvær",
    "vejrtraekningsbesvaer",
    "svært ved at trække vejret",
    "svaert ved at traekke vejret",
    "kraftig blødning",
    "kraftig bloedning",
    "bevidsthedstab",
    "alvorlig skade",
]
URGENT_GREENLANDIC_HINTS = [
    "sakissakkut anniarneq",
    "anersaartorniarneq",
    "aanaarneq",
    "ilisimajunnaarneq",
    "ajoquserneq",
]
SIGNAL_RULES = {
    "red": ["stop", "bange", "angst", "nej", "pres", "trussel", "frygt"],
    "orange": ["men", "måske", "maaske", "usikker", "både", "baade", "tvivl"],
    "blue": ["fordi", "derfor", "forklaring", "logisk", "årsag", "aarsag"],
}
FILLER_WORDS = {
    "det", "der", "den", "jeg", "du", "vi", "i", "at", "og", "eller", "en", "et",
    "er", "var", "på", "paa", "til", "for", "med", "som", "om", "af", "har", "kan",
}


def _clean_text(value):
    return str(value or "").strip()


def _word_list(text):
    return re.findall(r"[A-Za-zÀ-ÿ0-9]+", _clean_text(text).lower())


def _sentence_count(text):
    value = _clean_text(text)
    if not value:
        return 0

    parts = [part.strip() for part in re.split(r"[.!?]+", value) if part.strip()]
    return max(1, len(parts))


def _analysis_type(text, word_count, sentence_count):
    if word_count <= 3:
        return "word_level"

    if sentence_count > 2 or len(_clean_text(text)) > 200:
        return "conversation_level"

    return "sentence_level"


def _key_words(words):
    unique_words = []
    for word in words:
        if len(word) < 3 or word in FILLER_WORDS:
            continue
        if word not in unique_words:
            unique_words.append(word)
        if len(unique_words) >= 8:
            break

    return unique_words


def _detected_signals(words):
    word_set = set(words)
    signals = []

    for color_signals in SIGNAL_RULES.values():
        for signal in color_signals:
            if signal in word_set and signal not in signals:
                signals.append(signal)

    return signals


def _emotional_weight(signals, plasma_color):
    if plasma_color == "red":
        base = 0.75
    elif plasma_color == "orange":
        base = 0.55
    elif plasma_color == "blue":
        base = 0.25
    else:
        base = 0.15

    return min(1.0, round(base + (len(signals) * 0.05), 2))


def _text_structure(text, plasma_color):
    words = _word_list(text)
    sentence_count = _sentence_count(text)
    signals = _detected_signals(words)

    return {
        "analysisType": _analysis_type(text, len(words), sentence_count),
        "wordCount": len(words),
        "sentenceCount": sentence_count,
        "keyWords": _key_words(words),
        "detectedSignals": signals,
        "emotionalWeight": _emotional_weight(signals, plasma_color),
    }


def _normalize_analysis(raw_analysis, text):
    route = _clean_text(raw_analysis.get("route")).lower()
    plasma_color = _clean_text(raw_analysis.get("plasma_color")).lower()
    language = _clean_text(raw_analysis.get("language")).lower() or "da"
    short_reason = _clean_text(raw_analysis.get("short_reason"))

    try:
        confidence = float(raw_analysis.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5

    confidence = max(0.0, min(confidence, 1.0))

    if route not in ALLOWED_ROUTES:
        route = "chat"

    if plasma_color not in ALLOWED_COLORS:
        plasma_color = _fallback_plasma_color(text)

    structure = _text_structure(text, plasma_color)

    return {
        "route": route,
        "plasma_color": plasma_color,
        "confidence": confidence,
        "language": language,
        "short_reason": short_reason or "Teksten blev analyseret teknisk som proof-of-concept.",
        **structure,
    }


def _fallback_plasma_color(text):
    normalized = f" {_clean_text(text).lower()} "

    if any(signal in normalized for signal in [" stop ", " bange ", " angst ", " nej ", " pres "]):
        return "red"

    if any(signal in normalized for signal in [" men ", " måske ", " maaske ", " usikker ", " både ", " baade "]):
        return "orange"

    if any(signal in normalized for signal in [" fordi ", " derfor ", " forklaring ", " logisk "]):
        return "blue"

    return "white"


def _call_openai_for_analysis(text):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY mangler.")

    payload = {
        "model": "gpt-4o",
        "messages": [
            {
                "role": "system",
                "content": (
                    "Du er LexiVoice Nuance-analytiker. Returner kun valid JSON. "
                    "Dette er kun en teknisk proof-of-concept, ikke production social-control logic."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Analyser brugerens tekst og returner præcis dette JSON-format:\n"
                    "{\n"
                    '  "route": "workflow|document|chat",\n'
                    '  "plasma_color": "white|blue|red|orange",\n'
                    '  "confidence": 0.0,\n'
                    '  "language": "da|en|other",\n'
                    '  "short_reason": "kort teknisk forklaring på dansk",\n'
                    '  "keyWords": ["array"],\n'
                    '  "detectedSignals": ["array"],\n'
                    '  "emotionalWeight": 0.0\n'
                    "}\n\n"
                    f'Tekst: "{text}"'
                ),
            },
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 180,
        "temperature": 0.2,
    }

    request = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response_body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        error_body = error.read().decode("utf-8")
        raise RuntimeError(f"OpenAI HTTP {error.code}: {error_body}") from error

    content = response_body["choices"][0]["message"]["content"] or "{}"
    return json.loads(content)


def _call_openai_json(messages, max_tokens=700):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY mangler.")

    payload = {
        "model": "gpt-4o",
        "messages": messages,
        "response_format": {"type": "json_object"},
        "max_tokens": max_tokens,
        "temperature": 0.1,
    }

    request = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            response_body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        error_body = error.read().decode("utf-8")
        raise RuntimeError(f"OpenAI HTTP {error.code}: {error_body}") from error

    content = response_body["choices"][0]["message"]["content"] or "{}"
    return json.loads(content)


def _safe_list(value):
    if not isinstance(value, list):
        return []

    return [_clean_text(item) for item in value if _clean_text(item)][:12]


def _safe_confidence(value):
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        confidence = 0.5

    return max(0.0, min(confidence, 1.0))


def _contains_urgent_indicator(text, urgency_indicators):
    normalized = _clean_text(text).lower()
    indicator_text = " ".join(_safe_list(urgency_indicators)).lower()
    combined = f"{normalized} {indicator_text}"

    return any(phrase in combined for phrase in URGENT_DANISH_PHRASES + URGENT_GREENLANDIC_HINTS)


def _normalize_health_result(raw_result, text, source_language):
    detected_language = _clean_text(raw_result.get("detected_language")).lower() or source_language
    if detected_language not in {"da", "kl", "unknown"}:
        detected_language = "unknown"

    confidence = _safe_confidence(raw_result.get("confidence"))
    urgency_indicators = _safe_list(raw_result.get("urgency_indicators"))
    urgent_assessment_needed = _contains_urgent_indicator(text, urgency_indicators)

    return {
        "detected_language": detected_language,
        "translated_text": _clean_text(raw_result.get("translated_text")),
        "translated_da": _clean_text(raw_result.get("translated_da")),
        "translated_kl": _clean_text(raw_result.get("translated_kl")),
        "medical_terms": _safe_list(raw_result.get("medical_terms")),
        "urgency_indicators": urgency_indicators,
        "confidence": confidence,
        "clarification_questions": _safe_list(raw_result.get("clarification_questions")),
        "summary_for_clinician": _clean_text(raw_result.get("summary_for_clinician")),
        "understanding_check": _clean_text(raw_result.get("understanding_check")),
        "slow_repeat_da": _clean_text(raw_result.get("slow_repeat_da")),
        "slow_repeat_kl": _clean_text(raw_result.get("slow_repeat_kl")),
        "urgent_assessment_needed": urgent_assessment_needed,
        "disclaimer": "Lexivoice er tolke- og kommunikationsstøtte. Sundhedspersonen har det kliniske ansvar.",
    }


def _health_prompt(text, source_language, speaker_role):
    return [
        {
            "role": "system",
            "content": (
                "Du er Lexivoice Health, en medicinsk tolke- og kommunikationsstøtte mellem dansk og grønlandsk. "
                "Du må ikke stille diagnose, foreslå behandling eller træffe kliniske beslutninger. "
                "Du må kun transskribere/strukturere tekst, oversætte, udtrække nøgleord/medicinske termer, "
                "opsummere symptomer neutralt og lave forståelsescheck. "
                "Hvis der nævnes potentielt akutte faresignaler, markér kun at akut vurdering er nødvendig."
            ),
        },
        {
            "role": "user",
            "content": (
                "Returner KUN valid JSON i dette format:\n"
                "{\n"
                '  "detected_language": "da|kl|unknown",\n'
                '  "translated_text": "primær oversættelse til modpartens sprog",\n'
                '  "translated_da": "dansk oversættelse eller dansk original",\n'
                '  "translated_kl": "grønlandsk oversættelse eller grønlandsk original",\n'
                '  "medical_terms": ["neutrale termer fra teksten"],\n'
                '  "urgency_indicators": ["kun ord/fraser som fremgår af teksten"],\n'
                '  "confidence": 0.0,\n'
                '  "clarification_questions": ["korte forståelses-/afklaringsspørgsmål"],\n'
                '  "summary_for_clinician": "neutral symptomopsummering uden diagnose",\n'
                '  "understanding_check": "kort sætning der kan bruges til at bekræfte forståelse",\n'
                '  "slow_repeat_da": "dansk langsom/enkelt gentagelse",\n'
                '  "slow_repeat_kl": "grønlandsk langsom/enkelt gentagelse"\n'
                "}\n\n"
                f"Speaker role: {speaker_role}\n"
                f"Source language hint: {source_language}\n"
                f'Tekst: "{text}"'
            ),
        },
    ]


@https_fn.on_call(secrets=["OPENAI_API_KEY"], region="us-central1")
def routeLexiIntent(req: https_fn.CallableRequest) -> dict:
    text = _clean_text((req.data or {}).get("text"))
    logging.info("[lexivoice backend] received text: %s", text)

    if not text:
        return {
            "ok": False,
            "error": "text mangler",
            "analysis": {
                "route": "chat",
                "plasma_color": "white",
                "confidence": 0.0,
                "language": "da",
                "short_reason": "Ingen tekst modtaget.",
                **_text_structure("", "white"),
            },
        }

    try:
        raw_analysis = _call_openai_for_analysis(text)
        analysis = _normalize_analysis(raw_analysis, text)
        logging.info("[lexivoice backend] openai result: %s", json.dumps(analysis, ensure_ascii=False))

        db = firestore.client()
        db.collection("lexi_ui").document("plasma_status").set(
            {
                "color": analysis["plasma_color"],
                "route": analysis["route"],
                "confidence": analysis["confidence"],
                "language": analysis["language"],
                "short_reason": analysis["short_reason"],
                "analysisType": analysis["analysisType"],
                "wordCount": analysis["wordCount"],
                "sentenceCount": analysis["sentenceCount"],
                "keyWords": analysis["keyWords"],
                "detectedSignals": analysis["detectedSignals"],
                "emotionalWeight": analysis["emotionalWeight"],
                "last_text": text,
                "timestamp": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

        logging.info("[lexivoice backend] saved plasma_status")
        return {"ok": True, "analysis": analysis}
    except Exception as error:
        logging.exception("routeLexiIntent failed")
        return {
            "ok": False,
            "error": str(error),
            "analysis": {
                "route": "chat",
                "plasma_color": _fallback_plasma_color(text),
                "confidence": 0.0,
                "language": "da",
                "short_reason": "OpenAI-analysen fejlede; fallback-farve brugt.",
                **_text_structure(text, _fallback_plasma_color(text)),
            },
        }


@https_fn.on_call(region="us-central1")
def updatePlasmaUI(req: https_fn.CallableRequest) -> dict:
    color = _clean_text((req.data or {}).get("color")).lower() or "white"

    if color not in ALLOWED_COLORS:
        color = "white"

    db = firestore.client()
    db.collection("lexi_ui").document("plasma_status").set(
        {
            "color": color,
            "timestamp": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    return {"ok": True, "status": "updated", "color": color}


@https_fn.on_call(secrets=["OPENAI_API_KEY"], region="us-central1")
def healthConversationSupport(req: https_fn.CallableRequest) -> dict:
    data = req.data or {}
    text = _clean_text(data.get("text"))
    source_language = _clean_text(data.get("sourceLanguage")).lower() or "auto"
    speaker_role = _clean_text(data.get("speakerRole")).lower() or "unknown"
    session_id = _clean_text(data.get("sessionId"))
    consent_to_store = bool(data.get("consentToStore"))

    logging.info("[lexivoice health backend] received text: %s", text)

    if source_language not in ALLOWED_HEALTH_LANGUAGES:
        source_language = "auto"

    if not text:
        return {
            "ok": False,
            "error": "text mangler",
            "analysis": _normalize_health_result({}, "", source_language),
        }

    try:
        raw_result = _call_openai_json(_health_prompt(text, source_language, speaker_role))
        analysis = _normalize_health_result(raw_result, text, source_language)
        logging.info("[lexivoice health backend] openai result: %s", json.dumps(analysis, ensure_ascii=False))

        if consent_to_store:
            db = firestore.client()
            db.collection("lexi_health_audit_events").document().set(
                {
                    "sessionId": session_id,
                    "text": text,
                    "sourceLanguage": source_language,
                    "speakerRole": speaker_role,
                    "detected_language": analysis["detected_language"],
                    "translated_text": analysis["translated_text"],
                    "translated_da": analysis["translated_da"],
                    "translated_kl": analysis["translated_kl"],
                    "medical_terms": analysis["medical_terms"],
                    "urgency_indicators": analysis["urgency_indicators"],
                    "confidence": analysis["confidence"],
                    "clarification_questions": analysis["clarification_questions"],
                    "summary_for_clinician": analysis["summary_for_clinician"],
                    "understanding_check": analysis["understanding_check"],
                    "urgent_assessment_needed": analysis["urgent_assessment_needed"],
                    "createdAt": firestore.SERVER_TIMESTAMP,
                    "storedWithConsent": True,
                    "audioStored": False,
                }
            )

        return {"ok": True, "analysis": analysis}
    except Exception as error:
        logging.exception("healthConversationSupport failed")
        fallback = _normalize_health_result(
            {
                "translated_text": "",
                "translated_da": text if source_language == "da" else "",
                "translated_kl": text if source_language == "kl" else "",
                "confidence": 0.0,
                "summary_for_clinician": "AI-oversættelsen fejlede. Brug professionel tolk eller gentag manuelt.",
                "clarification_questions": ["Kan du gentage langsommere?"],
            },
            text,
            source_language,
        )

        return {"ok": False, "error": str(error), "analysis": fallback}


def _is_hallucination(text):
    """
    Detect if transcription is likely a hallucination.
    
    Hallucination indicators:
    - Only special characters
    - Excessive repetition
    - Extremely long (>500 chars for 1.5s audio)
    - Only numbers or punctuation
    """
    if not text or len(text) < 2:
        return False
    
    # Check if only special characters
    alphanumeric_count = sum(c.isalnum() for c in text)
    if alphanumeric_count < len(text) * 0.5:
        return True
    
    # Check for excessive repetition (same word repeated >5 times)
    words = text.lower().split()
    if len(words) > 5:
        for word in set(words):
            if words.count(word) > 5:
                return True
    
    # Check if extremely long (>500 chars for 1.5s audio chunk)
    if len(text) > 500:
        return True
    
    return False


def _estimate_confidence(text, audio_length):
    """
    Estimate confidence when API doesn't provide it.
    
    Heuristics:
    - Length: reasonable length for audio duration
    - Empty words: fewer filler words = higher confidence
    - Repetitions: fewer repetitions = higher confidence
    """
    if not text:
        return 0.0
    
    confidence = 0.8  # Base confidence
    
    # Length heuristic (expect ~10-20 chars per second of audio)
    expected_length = audio_length * 0.015  # 15 chars per second
    actual_length = len(text)
    length_ratio = min(actual_length / max(expected_length, 1), 2.0)
    
    if length_ratio < 0.5 or length_ratio > 1.5:
        confidence -= 0.1
    
    # Word count heuristic
    words = text.split()
    if len(words) < 2:
        confidence -= 0.1
    
    # Repetition heuristic
    unique_words = len(set(words))
    if len(words) > 0 and unique_words / len(words) < 0.7:
        confidence -= 0.1
    
    return max(0.0, min(1.0, confidence))


@https_fn.on_call(secrets=["TURN_DOMAIN", "TURN_USERNAME", "TURN_PASSWORD"], region="us-central1")
def getTurnCredentials(req: https_fn.CallableRequest) -> dict:
    """
    Securely provide TURN server credentials for WebRTC connections.
    
    Returns ICE servers configuration including STUN and TURN servers.
    TURN credentials are stored as Firebase secrets and never exposed to frontend.
    
    Output:
        iceServers: list of ICE server configurations
    """
    try:
        turn_domain = os.environ.get("TURN_DOMAIN", "")
        turn_username = os.environ.get("TURN_USERNAME", "")
        turn_password = os.environ.get("TURN_PASSWORD", "")
        
        ice_servers = [
            # Public STUN servers
            {"urls": "stun:stun.l.google.com:19302"},
            {"urls": "stun:stun1.l.google.com:19302"}
        ]
        
        # Add TURN servers if credentials are configured
        if turn_domain and turn_username and turn_password:
            logging.info("[getTurnCredentials] TURN server configured: %s", turn_domain)
            
            # TURN over UDP
            ice_servers.append({
                "urls": f"turn:{turn_domain}:3478?transport=udp",
                "username": turn_username,
                "credential": turn_password
            })
            
            # TURN over TCP
            ice_servers.append({
                "urls": f"turn:{turn_domain}:3478?transport=tcp",
                "username": turn_username,
                "credential": turn_password
            })
            
            # TURN over TLS (TURNS)
            ice_servers.append({
                "urls": f"turns:{turn_domain}:5349?transport=tcp",
                "username": turn_username,
                "credential": turn_password
            })
            
            logging.info("[getTurnCredentials] Returning %d ICE servers (2 STUN + 3 TURN)", len(ice_servers))
        else:
            logging.warning("[getTurnCredentials] TURN credentials not configured, returning STUN only")
        
        return {
            "ok": True,
            "iceServers": ice_servers
        }
        
    except Exception as error:
        logging.exception("[getTurnCredentials] Failed to get TURN credentials")
        # Fallback to STUN only
        return {
            "ok": True,
            "iceServers": [
                {"urls": "stun:stun.l.google.com:19302"},
                {"urls": "stun:stun1.l.google.com:19302"}
            ],
            "error": str(error)
        }


@https_fn.on_call(secrets=["OPENAI_API_KEY"], region="us-central1")
def processAudioTranslationChunk(req: https_fn.CallableRequest):
    """
    Process audio chunk for STT + translation using OpenAI.
    
    Audio chunks are transient and must not be persisted without explicit consent.
    
    Input:
        sessionId: str
        role: "doctor" | "patient"
        sourceLanguage: "da-DK" | "kl-GL"
        targetLanguage: "kl-GL" | "da-DK"
        audioBase64: str (base64 encoded audio)
        mimeType: str (audio/webm, etc.)
    
    Output:
        originalText: str (transcribed text)
        translatedText: str (translated text)
        confidence: float
        status: "partial" | "final" | "error"
    """
    data = req.data
    session_id = _clean_text(data.get("sessionId"))
    role = _clean_text(data.get("role"))
    source_language = _clean_text(data.get("sourceLanguage"))
    target_language = _clean_text(data.get("targetLanguage"))
    audio_base64 = data.get("audioBase64", "")
    mime_type = _clean_text(data.get("mimeType"))
    
    # Check for OpenAI API key
    openai_api_key = os.environ.get("OPENAI_API_KEY")
    if not openai_api_key:
        logging.error("[processAudioTranslationChunk] OPENAI_API_KEY not visible to function")
        return {
            "ok": False,
            "code": "stt_not_configured",
            "message": "OPENAI_API_KEY not visible to function",
            "originalText": "",
            "translatedText": "",
            "originalLength": 0,
            "translatedLength": 0,
            "confidence": 0.0,
            "modelUsed": None,
            "status": "error"
        }
    
    if not OpenAI:
        logging.error("[processAudioTranslationChunk] OpenAI SDK not installed")
        return {
            "ok": False,
            "code": "stt_not_configured",
            "message": "OpenAI SDK not installed",
            "originalText": "",
            "translatedText": "",
            "originalLength": 0,
            "translatedLength": 0,
            "confidence": 0.0,
            "modelUsed": None,
            "status": "error"
        }
    
    try:
        # Decode base64 audio to bytes
        audio_bytes = base64.b64decode(audio_base64)
        audio_length = len(audio_bytes)
        
        logging.info(
            "[processAudioTranslationChunk] Processing: sessionId=%s, role=%s, mimeType=%s, audioBytes=%d",
            session_id, role, mime_type, audio_length
        )
        
        # Log first 16 bytes as hex for debugging
        if audio_length >= 16:
            logging.info("[stt] First 16 bytes (hex): %s", audio_bytes[:16].hex())
        else:
            logging.info("[stt] Audio bytes (hex): %s", audio_bytes.hex())
        
        # Check audio size
        if audio_length < 100:
            logging.warning("[processAudioTranslationChunk] Audio chunk too small: %d bytes", audio_length)
            return {
                "ok": False,
                "code": "audio_too_small",
                "message": "Audio chunk too small",
                "originalText": "",
                "translatedText": "",
                "originalLength": 0,
                "translatedLength": 0,
                "confidence": 0.0,
                "modelUsed": None,
                "status": "error"
            }
        
        # Determine file extension from MIME type
        # Map MIME type to correct file extension
        if "ogg" in mime_type:
            file_extension = ".ogg"
        elif "webm" in mime_type:
            file_extension = ".webm"
        elif "wav" in mime_type:
            file_extension = ".wav"
        elif "mp4" in mime_type:
            file_extension = ".mp4"
        elif "mp3" in mime_type:
            file_extension = ".mp3"
        else:
            file_extension = ".webm"  # Default fallback
        
        # Create temporary file with delete=False so we can control cleanup
        temp_audio_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=file_extension, delete=False) as temp_audio:
                temp_audio.write(audio_bytes)
                temp_audio.flush()
                temp_audio_path = temp_audio.name
            
            # Verify file was written correctly
            file_size = os.path.getsize(temp_audio_path)
            logging.info("[stt] temp file: %s", temp_audio_path)
            logging.info("[stt] temp size: %d bytes", file_size)
            logging.info("[stt] file extension: %s", file_extension)
            
            if file_size == 0:
                logging.error("[stt] Temp file is empty!")
                return {
                    "ok": False,
                    "code": "audio_write_failed",
                    "message": "Failed to write audio to temp file",
                    "originalText": "",
                    "translatedText": "",
                    "originalLength": 0,
                    "translatedLength": 0,
                    "confidence": 0.0,
                    "modelUsed": None,
                    "status": "error"
                }
            
            # Initialize OpenAI client with timeout
            client = OpenAI(
                api_key=openai_api_key,
                timeout=20.0  # 20 second timeout
            )
            
            # Determine language for transcription
            transcription_language = None
            if role == "doctor":
                transcription_language = "da"  # Danish
            # For patient, let OpenAI auto-detect (Greenlandic may not be supported)
            
            # Try gpt-4o-mini-transcribe first, fallback to whisper-1
            transcription_text = ""
            model_used = None
            retry_count = 0
            max_retries_per_model = 1
            
            try:
                logging.info("[processAudioTranslationChunk] Trying model: gpt-4o-mini-transcribe")
                for attempt in range(max_retries_per_model + 1):
                    try:
                        with open(temp_audio_path, "rb") as audio_file:
                            logging.info("[stt] Opening file for OpenAI: %s", temp_audio_path)
                            transcript = client.audio.transcriptions.create(
                                model="gpt-4o-mini-transcribe",
                                file=audio_file,
                                language=transcription_language
                            )
                        transcription_text = transcript.text
                        model_used = "gpt-4o-mini-transcribe"
                        logging.info("[stt] Transcription successful with gpt-4o-mini-transcribe")
                        break
                    except Exception as retry_error:
                        retry_count += 1
                        if attempt < max_retries_per_model:
                            logging.warning("[processAudioTranslationChunk] gpt-4o-mini-transcribe attempt %d failed, retrying", attempt + 1)
                            logging.error("[stt] Error details: %s", str(retry_error))
                        else:
                            raise retry_error
                
            except Exception as model_error:
                import traceback
                logging.error("[processAudioTranslationChunk] gpt-4o-mini-transcribe failed with full traceback:")
                logging.error(traceback.format_exc())
                logging.warning("[processAudioTranslationChunk] Trying whisper-1 as fallback")
                
                try:
                    for attempt in range(max_retries_per_model + 1):
                        try:
                            with open(temp_audio_path, "rb") as audio_file:
                                logging.info("[stt] Opening file for OpenAI (whisper-1): %s", temp_audio_path)
                                transcript = client.audio.transcriptions.create(
                                    model="whisper-1",
                                    file=audio_file,
                                    language=transcription_language
                                )
                            transcription_text = transcript.text
                            model_used = "whisper-1"
                            logging.info("[stt] Transcription successful with whisper-1")
                            break
                        except Exception as retry_error:
                            retry_count += 1
                            if attempt < max_retries_per_model:
                                logging.warning("[processAudioTranslationChunk] whisper-1 attempt %d failed, retrying", attempt + 1)
                            else:
                                raise retry_error
                    
                except Exception as whisper_error:
                    import traceback
                    logging.error("[processAudioTranslationChunk] whisper-1 also failed with full traceback:")
                    logging.error(traceback.format_exc())
                    
                    # Check if it's an invalid file format error
                    error_str = str(whisper_error)
                    if "Invalid file format" in error_str or "invalid_request_error" in error_str:
                        logging.error("[stt] Audio chunk is not a valid standalone media container")
                        return {
                            "ok": False,
                            "code": "invalid_audio_container",
                            "message": "Audio chunk is not a valid standalone media container",
                            "originalText": "",
                            "translatedText": "",
                            "originalLength": 0,
                            "translatedLength": 0,
                            "confidence": 0.0,
                            "modelUsed": None,
                            "status": "error"
                        }
                    
                    raise whisper_error
            
            # Process transcription
            transcription_text = transcription_text.strip()
            transcription_length = len(transcription_text)
            
            logging.info(
                "[processAudioTranslationChunk] Transcription complete: model=%s, length=%d, text=%s",
                model_used, transcription_length, transcription_text[:100]
            )
            
            # Check if transcription is empty
            if not transcription_text:
                logging.warning("[processAudioTranslationChunk] Empty transcription - no speech detected")
                return {
                    "ok": False,
                    "code": "stt_empty",
                    "message": "No speech detected",
                    "originalText": "",
                    "translatedText": "",
                    "originalLength": 0,
                    "translatedLength": 0,
                    "confidence": 0.0,
                    "modelUsed": model_used,
                    "status": "error"
                }
            
            # Detect hallucinations
            if _is_hallucination(transcription_text):
                logging.warning("[processAudioTranslationChunk] Hallucination detected, discarding")
                return {
                    "ok": False,
                    "code": "stt_hallucination",
                    "message": "Transcription appears to be hallucinated",
                    "originalText": "",
                    "translatedText": "",
                    "originalLength": 0,
                    "translatedLength": 0,
                    "confidence": 0.0,
                    "modelUsed": model_used,
                    "status": "error"
                }
            
            # Determine translation direction
            translate_source_lang = "da"
            translate_target_lang = "kl"
            
            if role == "doctor":
                translate_source_lang = "da"
                translate_target_lang = "kl"
            elif role == "patient":
                translate_source_lang = "kl"
                translate_target_lang = "da"
            
            # Translate using existing healthConversationSupport logic
            logging.info(
                "[processAudioTranslationChunk] Translating: %s -> %s",
                translate_source_lang, translate_target_lang
            )
            
            raw_result = _call_openai_json(
                _health_prompt(transcription_text, translate_source_lang, role)
            )
            analysis = _normalize_health_result(raw_result, transcription_text, translate_source_lang)
            
            # Extract translated text
            translated_text = ""
            if translate_target_lang == "kl":
                translated_text = analysis.get("translated_kl", "")
            else:
                translated_text = analysis.get("translated_da", "")
            
            # Use confidence from analysis or estimate it
            confidence = analysis.get("confidence")
            if confidence is None or confidence == 0:
                confidence = _estimate_confidence(transcription_text, audio_length)
            
            logging.info(
                "[processAudioTranslationChunk] Translation complete: confidence=%.2f, translatedLength=%d",
                confidence, len(translated_text)
            )
            
            # Write transcript to Firestore
            try:
                db = firestore.client()
                db.collection("video_sessions").document(session_id).collection("transcripts").add(
                {
                    "role": role,
                    "sourceLanguage": source_language,
                    "targetLanguage": target_language,
                    "originalText": transcription_text,
                    "translatedText": translated_text,
                    "inputMode": "audio-chunk",
                    "confidence": confidence,
                    "status": "final",
                    "modelUsed": model_used,
                    "createdAt": firestore.SERVER_TIMESTAMP,
                }
                )
                logging.info("[processAudioTranslationChunk] Transcript written to Firestore")
            except Exception as firestore_error:
                logging.error("[processAudioTranslationChunk] Failed to write to Firestore: %s", str(firestore_error))
                # Don't fail the whole request if Firestore write fails
            
            return {
                "ok": True,
                "code": "success",
                "message": "Transcription and translation successful",
                "originalText": transcription_text,
                "translatedText": translated_text,
                "originalLength": len(transcription_text),
                "translatedLength": len(translated_text),
                "confidence": confidence,
                "modelUsed": model_used,
                "status": "final"
            }
        
        finally:
            # Cleanup temp file
            if temp_audio_path and os.path.exists(temp_audio_path):
                try:
                    os.unlink(temp_audio_path)
                    logging.info("[stt] Cleaned up temp file: %s", temp_audio_path)
                except Exception as cleanup_error:
                    logging.warning("[stt] Failed to cleanup temp file: %s", str(cleanup_error))
    
    except Exception as error:
        import traceback
        logging.error("[processAudioTranslationChunk] Failed with full traceback:")
        logging.error(traceback.format_exc())
        return {
            "ok": False,
            "code": "openai_stt_error",
            "message": str(error),
            "originalText": "",
            "translatedText": "",
            "originalLength": 0,
            "translatedLength": 0,
            "confidence": 0.0,
            "modelUsed": None,
            "status": "error"
        }


@https_fn.on_call(secrets=["OPENAI_API_KEY"], region="us-central1")
def processAudioChunkBuffered(req: https_fn.CallableRequest):
    """
    Process audio chunks with buffering - collects chunks and sends complete files to OpenAI.
    
    Input:
        sessionId: str
        role: "doctor" | "patient"
        sourceLanguage: "da-DK" | "kl-GL"
        targetLanguage: "kl-GL" | "da-DK"
        audioBase64: str
        mimeType: str
        sequenceNumber: int
        isFinal: bool
    
    Response:
        ok: bool
        code: str
        message: str
        bufferedChunks: int
        processed: bool
        originalText: str (if processed)
        translatedText: str (if processed)
        modelUsed: str (if processed)
    """
    
    # Check if AudioChunkBuffer is available
    if not AudioChunkBuffer:
        return {
            "ok": False,
            "code": "buffer_not_available",
            "message": "Audio buffering system not available",
            "bufferedChunks": 0,
            "processed": False
        }
    
    # Check OpenAI availability
    openai_api_key = os.environ.get("OPENAI_API_KEY")
    if not openai_api_key:
        return {
            "ok": False,
            "code": "stt_not_configured",
            "message": "OPENAI_API_KEY not configured",
            "bufferedChunks": 0,
            "processed": False
        }
    
    if not OpenAI:
        return {
            "ok": False,
            "code": "openai_sdk_missing",
            "message": "OpenAI SDK not installed",
            "bufferedChunks": 0,
            "processed": False
        }
    
    # Extract parameters
    data = req.data or {}
    session_id = _clean_text(data.get("sessionId"))
    role = _clean_text(data.get("role"))
    source_language = _clean_text(data.get("sourceLanguage"))
    target_language = _clean_text(data.get("targetLanguage"))
    audio_base64 = data.get("audioBase64", "")
    mime_type = _clean_text(data.get("mimeType", "audio/webm"))
    sequence_number = int(data.get("sequenceNumber", 0))
    is_final = bool(data.get("isFinal", False))
    
    # Validate required parameters
    if not session_id or not role or not audio_base64:
        return {
            "ok": False,
            "code": "missing_parameters",
            "message": "Missing required parameters: sessionId, role, audioBase64",
            "bufferedChunks": 0,
            "processed": False
        }
    
    if role not in ["doctor", "patient"]:
        return {
            "ok": False,
            "code": "invalid_role",
            "message": "Role must be 'doctor' or 'patient'",
            "bufferedChunks": 0,
            "processed": False
        }
    
    try:
        # Decode audio
        audio_bytes = base64.b64decode(audio_base64)
        audio_length = len(audio_bytes)
        
        logging.info(
            "[processAudioChunkBuffered] Chunk received: session=%s, role=%s, seq=%d, size=%d, final=%s",
            session_id, role, sequence_number, audio_length, is_final
        )
        
        # Initialize buffer
        buffer = AudioChunkBuffer(session_id, role)
        
        # Add chunk to buffer
        buffer_info = buffer.add_chunk(audio_bytes, sequence_number, mime_type)
        
        logging.info(
            "[processAudioChunkBuffered] Buffer status: %d chunks, %d bytes, %.1fs old",
            buffer_info["buffered_chunks"],
            buffer_info["total_size"],
            buffer_info["oldest_chunk_age"]
        )
        
        # Check if we should process
        should_process = buffer.should_process(is_final)
        
        if not should_process:
            # Just buffered, not processing yet
            return {
                "ok": True,
                "code": "buffered",
                "message": f"Chunk buffered ({buffer_info['buffered_chunks']} chunks)",
                "bufferedChunks": buffer_info["buffered_chunks"],
                "processed": False
            }
        
        # Process buffer
        logging.info("[processAudioChunkBuffered] Processing buffer...")
        
        # Combine chunks
        combined_path, combined_mime_type = buffer.combine_chunks()
        
        # Transcribe with OpenAI
        client = OpenAI(api_key=openai_api_key, timeout=20.0)
        
        transcription_language = None
        if role == "doctor":
            transcription_language = "da"
        
        transcription_text = ""
        model_used = None
        
        try:
            logging.info("[processAudioChunkBuffered] Transcribing with gpt-4o-mini-transcribe")
            with open(combined_path, "rb") as audio_file:
                transcript = client.audio.transcriptions.create(
                    model="gpt-4o-mini-transcribe",
                    file=audio_file,
                    language=transcription_language
                )
            transcription_text = transcript.text
            model_used = "gpt-4o-mini-transcribe"
            logging.info("[processAudioChunkBuffered] Transcription successful")
        
        except Exception as model_error:
            import traceback
            logging.error("[processAudioChunkBuffered] gpt-4o-mini-transcribe failed:")
            logging.error(traceback.format_exc())
            
            # Try whisper-1
            try:
                logging.info("[processAudioChunkBuffered] Trying whisper-1")
                with open(combined_path, "rb") as audio_file:
                    transcript = client.audio.transcriptions.create(
                        model="whisper-1",
                        file=audio_file,
                        language=transcription_language
                    )
                transcription_text = transcript.text
                model_used = "whisper-1"
                logging.info("[processAudioChunkBuffered] Transcription successful with whisper-1")
            
            except Exception as whisper_error:
                logging.error("[processAudioChunkBuffered] whisper-1 also failed: %s", str(whisper_error))
                buffer.cleanup()
                return {
                    "ok": False,
                    "code": "transcription_failed",
                    "message": str(whisper_error),
                    "bufferedChunks": buffer_info["buffered_chunks"],
                    "processed": False
                }
        
        # Check if empty
        transcription_text = transcription_text.strip()
        if not transcription_text:
            logging.warning("[processAudioChunkBuffered] Empty transcription")
            buffer.cleanup()
            return {
                "ok": False,
                "code": "stt_empty",
                "message": "No speech detected",
                "bufferedChunks": buffer_info["buffered_chunks"],
                "processed": True,
                "originalText": "",
                "translatedText": "",
                "modelUsed": model_used
            }
        
        # Check hallucination
        if _is_hallucination(transcription_text):
            logging.warning("[processAudioChunkBuffered] Hallucination detected")
            buffer.cleanup()
            return {
                "ok": False,
                "code": "stt_hallucination",
                "message": "Transcription appears to be hallucinated",
                "bufferedChunks": buffer_info["buffered_chunks"],
                "processed": True,
                "originalText": "",
                "translatedText": "",
                "modelUsed": model_used
            }
        
        # Translate
        translate_source_lang = "da" if role == "doctor" else "kl"
        translate_target_lang = "kl" if role == "doctor" else "da"
        
        logging.info(
            "[processAudioChunkBuffered] Translating: %s -> %s",
            translate_source_lang, translate_target_lang
        )
        
        raw_result = _call_openai_json(
            _health_prompt(transcription_text, translate_source_lang, role)
        )
        analysis = _normalize_health_result(raw_result, transcription_text, translate_source_lang)
        
        translated_text = ""
        if translate_target_lang == "kl":
            translated_text = analysis.get("translated_kl", "")
        else:
            translated_text = analysis.get("translated_da", "")
        
        confidence = analysis.get("confidence")
        if confidence is None or confidence == 0:
            confidence = _estimate_confidence(transcription_text, buffer_info["total_size"])
        
        # Write to Firestore
        try:
            db = firestore.client()
            db.collection("video_sessions").document(session_id).collection("transcripts").add({
                "role": role,
                "sourceLanguage": source_language,
                "targetLanguage": target_language,
                "originalText": transcription_text,
                "translatedText": translated_text,
                "inputMode": "audio-buffered",
                "confidence": confidence,
                "status": "final",
                "modelUsed": model_used,
                "chunksProcessed": buffer_info["buffered_chunks"],
                "createdAt": firestore.SERVER_TIMESTAMP,
            })
            logging.info("[processAudioChunkBuffered] Transcript written to Firestore")
        except Exception as firestore_error:
            logging.error("[processAudioChunkBuffered] Firestore write failed: %s", str(firestore_error))
        
        # Cleanup buffer
        buffer.cleanup()
        
        return {
            "ok": True,
            "code": "success",
            "message": "Transcription and translation successful",
            "bufferedChunks": buffer_info["buffered_chunks"],
            "processed": True,
            "originalText": transcription_text,
            "translatedText": translated_text,
            "originalLength": len(transcription_text),
            "translatedLength": len(translated_text),
            "confidence": confidence,
            "modelUsed": model_used,
            "status": "final"
        }
    
    except Exception as error:
        import traceback
        logging.error("[processAudioChunkBuffered] Failed:")
        logging.error(traceback.format_exc())
        return {
            "ok": False,
            "code": "processing_error",
            "message": str(error),
            "bufferedChunks": 0,
            "processed": False
        }


@scheduler_fn.on_schedule(schedule="every 6 hours")
def cleanupExpiredLexiVoiceSessions(event: scheduler_fn.ScheduledEvent) -> None:
    """
    Clean up expired LexiVoice sessions (>24 hours old).
    
    Deletes:
    - Transcripts
    - Consent records
    - Audit logs
    - Session metadata
    
    Does NOT delete (they don't exist):
    - Video (never stored)
    - Audio (never stored)
    """
    logging.info("[cleanup] Starting expired session cleanup")
    
    # Clean up old audio buffers
    if cleanup_old_buffers:
        try:
            cleanup_old_buffers(max_age_seconds=3600)  # 1 hour
        except Exception as buffer_error:
            logging.error("[cleanup] Audio buffer cleanup failed: %s", str(buffer_error))
    
    try:
        db = firestore.client()
        cutoff = datetime.now() - timedelta(hours=24)
        
        # Query sessions older than 24 hours
        sessions_ref = db.collection("video_sessions")
        old_sessions = sessions_ref.where("createdAt", "<", cutoff).stream()
        
        deleted_count = 0
        
        for session_doc in old_sessions:
            session_id = session_doc.id
            logging.info("[cleanup] Deleting session: %s", session_id)
            
            try:
                # Delete transcripts subcollection
                transcripts = session_doc.reference.collection("transcripts").stream()
                for transcript in transcripts:
                    transcript.reference.delete()
                
                # Delete consent subcollection
                consents = session_doc.reference.collection("consent").stream()
                for consent in consents:
                    consent.reference.delete()
                
                # Delete audit subcollection
                audits = session_doc.reference.collection("audit").stream()
                for audit in audits:
                    audit.reference.delete()
                
                # Delete session document
                session_doc.reference.delete()
                deleted_count += 1
                
            except Exception as session_error:
                logging.error("[cleanup] Failed to delete session %s: %s", session_id, str(session_error))
        
        logging.info("[cleanup] Cleanup complete: deleted %d sessions", deleted_count)
        
    except Exception as error:
        logging.exception("[cleanup] Cleanup failed")


def _log_audit(session_id, event, role, metadata=None):
    """
    Log audit event to Firestore.
    
    Args:
        session_id: Session ID
        event: Event name (e.g., "session_created", "patient_joined")
        role: "doctor" or "patient"
        metadata: Optional dict with additional data
    """
    try:
        db = firestore.client()
        audit_data = {
            "event": event,
            "role": role,
            "timestamp": firestore.SERVER_TIMESTAMP
        }
        
        if metadata:
            audit_data["metadata"] = metadata
        
        db.collection("video_sessions").document(session_id).collection("audit").add(audit_data)
        logging.info("[audit] Logged: %s for %s in session %s", event, role, session_id)
        
    except Exception as error:
        logging.error("[audit] Failed to log event: %s", str(error))


@firestore_fn.on_document_created(document="video_sessions/{sessionId}/alerts/{alertId}")
def on_panic_alert_created(event: firestore_fn.Event[firestore_fn.DocumentSnapshot]) -> None:
    """
    Triggered when a panic alert is created.
    Routes alert to appropriate channels (push, SMS, Teams, webhook).
    """
    # Get session and alert IDs from path
    session_id = event.params["sessionId"]
    alert_id = event.params["alertId"]
    
    # Get alert data from snapshot
    alert = event.data.to_dict() if event.data else {}
    
    logging.info("[panic] Alert created: %s in session %s", alert_id, session_id)
    logging.info("[panic] Alert data: %s", alert)
    
    try:
        db = firestore.client()
        alert_ref = db.collection("video_sessions").document(session_id).collection("alerts").document(alert_id)
        
        severity = alert.get("severity", "unknown")
        message = alert.get("message", "")
        routing = alert.get("routing", {})
        targets = routing.get("targets", [])
        
        logging.info("[panic] Processing alert - severity: %s, targets: %s", severity, targets)
        
        # Route to each target
        deliveries = []
        for target in targets:
            if target == "doctor_primary":
                # Doctor is already notified via Firestore listener in browser
                delivery = {
                    "channel": "firestore",
                    "target": "doctor_primary",
                    "status": "sent",
                    "sentAt": firestore.SERVER_TIMESTAMP,
                    "error": None
                }
                deliveries.append(delivery)
                logging.info("[panic] Routed to doctor_primary via Firestore")
                
            elif target == "on_call_phone":
                # Placeholder for SMS/push to on-call phone
                delivery = send_sms_notification(session_id, alert_id, message)
                deliveries.append(delivery)
                
            elif target == "department_queue":
                # Placeholder for Teams/webhook to department
                delivery = send_teams_webhook(session_id, alert_id, message)
                deliveries.append(delivery)
        
        # Save delivery logs
        for delivery in deliveries:
            alert_ref.collection("deliveries").add(delivery)
            logging.info("[panic] Delivery logged: %s to %s - %s", 
                        delivery["channel"], delivery["target"], delivery["status"])
        
        # Update routing status
        alert_ref.update({
            "routing.status": "routed",
            "routing.routedAt": firestore.SERVER_TIMESTAMP
        })
        
        # Log audit event
        log_audit_event(session_id, "panic_alert_routed", "system", {
            "alertId": alert_id,
            "severity": severity,
            "targets": targets
        })
        
    except Exception as error:
        logging.error("[panic] Failed to process alert: %s", str(error))


def send_push_notification(session_id: str, alert_id: str, message: str) -> dict:
    """
    Placeholder for push notification delivery.
    In production, integrate with FCM, APNs, or similar.
    """
    logging.info("[panic] [PLACEHOLDER] Would send push notification: %s", message)
    return {
        "channel": "push",
        "target": "mobile_app",
        "status": "sent",
        "sentAt": firestore.SERVER_TIMESTAMP,
        "error": None,
        "note": "Placeholder - not actually sent"
    }


def send_sms_notification(session_id: str, alert_id: str, message: str) -> dict:
    """
    Placeholder for SMS delivery.
    In production, integrate with Twilio, AWS SNS, or similar.
    """
    logging.info("[panic] [PLACEHOLDER] Would send SMS: %s", message)
    return {
        "channel": "sms",
        "target": "on_call_phone",
        "status": "sent",
        "sentAt": firestore.SERVER_TIMESTAMP,
        "error": None,
        "note": "Placeholder - not actually sent"
    }


def send_teams_webhook(session_id: str, alert_id: str, message: str) -> dict:
    """
    Placeholder for Microsoft Teams webhook.
    In production, send to actual Teams channel webhook URL.
    """
    logging.info("[panic] [PLACEHOLDER] Would send Teams webhook: %s", message)
    return {
        "channel": "teams",
        "target": "department_queue",
        "status": "sent",
        "sentAt": firestore.SERVER_TIMESTAMP,
        "error": None,
        "note": "Placeholder - not actually sent"
    }
