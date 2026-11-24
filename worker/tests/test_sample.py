import pytest

from fama_worker.model import Chapter, Document
from fama_worker.sample import sample_text


def test_sample_reads_only_complete_sentences_from_the_first_body_paragraph():
    first = "The ferry crosses the harbour. " * 9
    overflow = "The captain waits until the last passenger is safely aboard."
    document = Document("Title", "Author", "en", (
        Chapter("Empty", "\n\n"),
        Chapter("Chapter heading", f"{first}{overflow}\n\nThe second paragraph is short."),
    ))

    assert sample_text(document) == first.strip()


def test_sample_bounds_a_long_sentence_without_a_nearby_sentence_end():
    document = Document("Title", None, "en", (Chapter("Chapter", "Icelandic words " * 100),))

    text = sample_text(document)
    assert len(text) <= 300
    assert document.chapters[0].text.startswith(f"{text} ")


def test_sample_reports_an_empty_document():
    with pytest.raises(ValueError, match="no body text"):
        sample_text(Document("Title", None, "en", (Chapter("Chapter", "---"),)))
