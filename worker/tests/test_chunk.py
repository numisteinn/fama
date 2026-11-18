from fama_worker.chunk import chunk_text


def test_sentences_pack_up_to_the_limit_and_never_cross_paragraphs():
    text = "One two three. Four five six. Seven eight.\n\nNew paragraph here."
    chunks = chunk_text(text, limit=30)
    assert [c.text for c in chunks] == ["One two three. Four five six.", "Seven eight.", "New paragraph here."]
    assert [c.ends_paragraph for c in chunks] == [False, True, True]


def test_long_sentence_splits_at_clauses_then_words():
    sentence = "This clause is long, " * 10 + "and it ends here."
    chunks = chunk_text(sentence, limit=50)
    assert all(len(c.text) <= 50 for c in chunks)
    assert " ".join(c.text for c in chunks).split() == sentence.split()


def test_icelandic_capitals_start_sentences():
    chunks = chunk_text("Hann fór heim. Þá kom hún.", limit=15)
    assert [c.text for c in chunks] == ["Hann fór heim.", "Þá kom hún."]


def test_empty_paragraphs_are_skipped():
    assert chunk_text("* * *\n\nText.", limit=100)[0].text == "Text."
