use {
    base64::{Engine, engine::general_purpose::STANDARD},
    serde_json::{Map, Number, Value},
    solana_pubkey::Pubkey,
    std::collections::BTreeMap,
};

#[derive(Debug, Clone, Copy)]
pub(super) struct DecodeLimits {
    pub max_payload_bytes: usize,
    pub max_sequence_len: usize,
    pub max_string_bytes: usize,
    pub max_depth: usize,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            max_payload_bytes: 16 * 1024,
            max_sequence_len: 4_096,
            max_string_bytes: 8 * 1024,
            max_depth: 32,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct TypeRegistry {
    definitions: BTreeMap<String, Value>,
}

impl TypeRegistry {
    pub fn from_idl(idl: &Value) -> Result<Self, String> {
        let mut definitions = BTreeMap::new();
        let types = idl
            .get("types")
            .and_then(Value::as_array)
            .ok_or_else(|| "IDL does not contain a types array".to_owned())?;
        for definition in types {
            let name = definition
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "IDL type is missing its name".to_owned())?;
            if definitions
                .insert(name.to_owned(), definition.clone())
                .is_some()
            {
                return Err(format!("duplicate IDL type: {name}"));
            }
        }
        Ok(Self { definitions })
    }

    pub fn contains(&self, name: &str) -> bool {
        self.definitions.contains_key(name)
    }

    pub fn decode_named_type(
        &self,
        name: &str,
        bytes: &[u8],
        limits: DecodeLimits,
    ) -> Result<Value, String> {
        self.require_payload_limit(bytes, limits)?;
        let mut cursor = BorshCursor::new(bytes);
        let value = self.decode_defined(name, &mut cursor, limits, 0)?;
        cursor.finish()?;
        Ok(value)
    }

    pub fn decode_fields(
        &self,
        fields: &[Value],
        bytes: &[u8],
        limits: DecodeLimits,
    ) -> Result<Value, String> {
        self.require_payload_limit(bytes, limits)?;
        let mut cursor = BorshCursor::new(bytes);
        let value = self.decode_field_list(fields, &mut cursor, limits, 0)?;
        cursor.finish()?;
        Ok(value)
    }

    fn require_payload_limit(&self, bytes: &[u8], limits: DecodeLimits) -> Result<(), String> {
        if bytes.len() > limits.max_payload_bytes {
            return Err(format!(
                "payload has {} bytes; limit is {}",
                bytes.len(),
                limits.max_payload_bytes
            ));
        }
        Ok(())
    }

    fn decode_defined(
        &self,
        name: &str,
        cursor: &mut BorshCursor<'_>,
        limits: DecodeLimits,
        depth: usize,
    ) -> Result<Value, String> {
        self.check_depth(depth, limits)?;
        let definition = self
            .definitions
            .get(name)
            .ok_or_else(|| format!("IDL references unknown type {name}"))?;
        let type_definition = definition
            .get("type")
            .ok_or_else(|| format!("IDL type {name} has no type definition"))?;
        self.decode_type_definition(type_definition, cursor, limits, depth + 1)
    }

    fn decode_type_definition(
        &self,
        definition: &Value,
        cursor: &mut BorshCursor<'_>,
        limits: DecodeLimits,
        depth: usize,
    ) -> Result<Value, String> {
        self.check_depth(depth, limits)?;
        let kind = definition
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "IDL type definition has no kind".to_owned())?;
        match kind {
            "struct" => {
                let fields = definition
                    .get("fields")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "IDL struct has no fields array".to_owned())?;
                self.decode_field_list(fields, cursor, limits, depth + 1)
            }
            "enum" => self.decode_enum(definition, cursor, limits, depth + 1),
            other => Err(format!("unsupported IDL type definition kind: {other}")),
        }
    }

    fn decode_enum(
        &self,
        definition: &Value,
        cursor: &mut BorshCursor<'_>,
        limits: DecodeLimits,
        depth: usize,
    ) -> Result<Value, String> {
        let variants = definition
            .get("variants")
            .and_then(Value::as_array)
            .ok_or_else(|| "IDL enum has no variants array".to_owned())?;
        let index = usize::from(cursor.read_u8()?);
        let variant = variants
            .get(index)
            .ok_or_else(|| format!("enum variant index {index} is out of range"))?;
        let name = variant
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "IDL enum variant is missing its name".to_owned())?;
        let mut output = Map::new();
        output.insert("variant".to_owned(), Value::String(name.to_owned()));
        if let Some(fields) = variant.get("fields").and_then(Value::as_array) {
            output.insert(
                "fields".to_owned(),
                self.decode_field_list(fields, cursor, limits, depth + 1)?,
            );
        }
        Ok(Value::Object(output))
    }

    fn decode_field_list(
        &self,
        fields: &[Value],
        cursor: &mut BorshCursor<'_>,
        limits: DecodeLimits,
        depth: usize,
    ) -> Result<Value, String> {
        self.check_depth(depth, limits)?;
        let named = fields
            .iter()
            .all(|field| field.get("name").and_then(Value::as_str).is_some());
        if named {
            let mut object = Map::new();
            for field in fields {
                let name = field
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "named IDL field lost its name".to_owned())?;
                let field_type = field
                    .get("type")
                    .ok_or_else(|| format!("IDL field {name} has no type"))?;
                let value = self.decode_type(field_type, cursor, limits, depth + 1)?;
                object.insert(name.to_owned(), value);
            }
            return Ok(Value::Object(object));
        }

        let mut tuple = Vec::with_capacity(fields.len());
        for field_type in fields {
            tuple.push(self.decode_type(field_type, cursor, limits, depth + 1)?);
        }
        Ok(Value::Array(tuple))
    }

    fn decode_type(
        &self,
        field_type: &Value,
        cursor: &mut BorshCursor<'_>,
        limits: DecodeLimits,
        depth: usize,
    ) -> Result<Value, String> {
        self.check_depth(depth, limits)?;
        if let Some(primitive) = field_type.as_str() {
            return self.decode_primitive(primitive, cursor, limits);
        }
        let object = field_type
            .as_object()
            .ok_or_else(|| format!("invalid IDL field type: {field_type}"))?;

        if let Some(defined) = object.get("defined") {
            let name = defined
                .as_str()
                .or_else(|| defined.get("name").and_then(Value::as_str))
                .ok_or_else(|| "defined IDL type is missing its name".to_owned())?;
            return self.decode_defined(name, cursor, limits, depth + 1);
        }
        if let Some(inner) = object.get("option") {
            return match cursor.read_u8()? {
                0 => Ok(Value::Null),
                1 => self.decode_type(inner, cursor, limits, depth + 1),
                tag => Err(format!("invalid Borsh option tag {tag}")),
            };
        }
        if let Some(inner) = object.get("vec") {
            let len = cursor.read_len(limits.max_sequence_len, "vector")?;
            if inner.as_str() == Some("u8") {
                return Ok(Value::String(STANDARD.encode(cursor.take(len)?)));
            }
            let mut values = Vec::with_capacity(len);
            for _ in 0..len {
                values.push(self.decode_type(inner, cursor, limits, depth + 1)?);
            }
            return Ok(Value::Array(values));
        }
        if let Some(array) = object.get("array").and_then(Value::as_array) {
            if array.len() != 2 {
                return Err("IDL array type must contain element type and length".to_owned());
            }
            let element_type = &array[0];
            let len_u64 = array[1]
                .as_u64()
                .ok_or_else(|| "IDL array length is not an unsigned integer".to_owned())?;
            let len = usize::try_from(len_u64)
                .map_err(|_| "IDL array length does not fit usize".to_owned())?;
            if len > limits.max_sequence_len {
                return Err(format!(
                    "IDL array length {len} exceeds limit {}",
                    limits.max_sequence_len
                ));
            }
            if element_type.as_str() == Some("u8") {
                return Ok(Value::String(format!(
                    "0x{}",
                    encode_hex(cursor.take(len)?)
                )));
            }
            let mut values = Vec::with_capacity(len);
            for _ in 0..len {
                values.push(self.decode_type(element_type, cursor, limits, depth + 1)?);
            }
            return Ok(Value::Array(values));
        }
        Err(format!("unsupported IDL field type: {field_type}"))
    }

    fn decode_primitive(
        &self,
        primitive: &str,
        cursor: &mut BorshCursor<'_>,
        limits: DecodeLimits,
    ) -> Result<Value, String> {
        let decimal = |value: String| Ok(Value::String(value));
        match primitive {
            "bool" => match cursor.read_u8()? {
                0 => Ok(Value::Bool(false)),
                1 => Ok(Value::Bool(true)),
                tag => Err(format!("invalid Borsh bool tag {tag}")),
            },
            "u8" => decimal(cursor.read_u8()?.to_string()),
            "i8" => decimal(i8::from_le_bytes(cursor.read_array()?).to_string()),
            "u16" => decimal(u16::from_le_bytes(cursor.read_array()?).to_string()),
            "i16" => decimal(i16::from_le_bytes(cursor.read_array()?).to_string()),
            "u32" => decimal(u32::from_le_bytes(cursor.read_array()?).to_string()),
            "i32" => decimal(i32::from_le_bytes(cursor.read_array()?).to_string()),
            "u64" => decimal(u64::from_le_bytes(cursor.read_array()?).to_string()),
            "i64" => decimal(i64::from_le_bytes(cursor.read_array()?).to_string()),
            "u128" => decimal(u128::from_le_bytes(cursor.read_array()?).to_string()),
            "i128" => decimal(i128::from_le_bytes(cursor.read_array()?).to_string()),
            "f32" => Number::from_f64(f64::from(f32::from_le_bytes(cursor.read_array()?)))
                .map(Value::Number)
                .ok_or_else(|| "Borsh f32 is not finite JSON".to_owned()),
            "f64" => Number::from_f64(f64::from_le_bytes(cursor.read_array()?))
                .map(Value::Number)
                .ok_or_else(|| "Borsh f64 is not finite JSON".to_owned()),
            "pubkey" => {
                let bytes: [u8; 32] = cursor.read_array()?;
                Ok(Value::String(Pubkey::new_from_array(bytes).to_string()))
            }
            "string" => {
                let len = cursor.read_len(limits.max_string_bytes, "string")?;
                let value = std::str::from_utf8(cursor.take(len)?)
                    .map_err(|error| format!("Borsh string is not UTF-8: {error}"))?;
                Ok(Value::String(value.to_owned()))
            }
            "bytes" => {
                let len = cursor.read_len(limits.max_payload_bytes, "byte vector")?;
                Ok(Value::String(STANDARD.encode(cursor.take(len)?)))
            }
            other => Err(format!("unsupported IDL primitive type: {other}")),
        }
    }

    fn check_depth(&self, depth: usize, limits: DecodeLimits) -> Result<(), String> {
        if depth > limits.max_depth {
            return Err(format!(
                "IDL decode depth {depth} exceeds limit {}",
                limits.max_depth
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn definition(&self, name: &str) -> Option<&Value> {
        self.definitions.get(name)
    }
}

struct BorshCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> BorshCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| "Borsh cursor offset overflow".to_owned())?;
        let value = self.bytes.get(self.offset..end).ok_or_else(|| {
            format!(
                "truncated Borsh payload at byte {}: need {len}, have {}",
                self.offset,
                self.bytes.len().saturating_sub(self.offset)
            )
        })?;
        self.offset = end;
        Ok(value)
    }

    fn read_array<const N: usize>(&mut self) -> Result<[u8; N], String> {
        self.take(N)?
            .try_into()
            .map_err(|_| format!("failed to read {N}-byte Borsh value"))
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        Ok(self.read_array::<1>()?[0])
    }

    fn read_len(&mut self, maximum: usize, label: &str) -> Result<usize, String> {
        let value = u32::from_le_bytes(self.read_array()?);
        let len =
            usize::try_from(value).map_err(|_| format!("{label} length does not fit usize"))?;
        if len > maximum {
            return Err(format!("{label} length {len} exceeds limit {maximum}"));
        }
        Ok(len)
    }

    fn finish(&self) -> Result<(), String> {
        if self.offset != self.bytes.len() {
            return Err(format!(
                "Borsh payload has {} trailing bytes",
                self.bytes.len() - self.offset
            ));
        }
        Ok(())
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}
